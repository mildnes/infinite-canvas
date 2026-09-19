#!/usr/bin/env python3
"""Offline SQLite task-media migration. Dry-run unless --apply is supplied.

Stop application writes before --apply. This tool never VACUUMs or deletes
existing media. Keep both the database backup and generated-media directory.
"""

import argparse
import base64
import errno
import hashlib
import json
import os
import sqlite3
import sys
import time
import uuid
from pathlib import Path


def decode_image(value):
    if not value.startswith("data:image/"):
        return None
    header, marker, encoded = value.partition(",")
    if marker != "," or ";base64" not in header.lower():
        raise ValueError("invalid image data URL")
    mime = header[5:].split(";", 1)[0].lower()
    suffix = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif"}.get(mime, ".bin")
    return mime, suffix, base64.b64decode(encoded, validate=True)


def decode_audio(value):
    if not value.startswith("data:audio/"):
        return None
    header, marker, encoded = value.partition(",")
    if marker != "," or ";base64" not in header.lower():
        raise ValueError("invalid audio data URL")
    mime = header[5:].split(";", 1)[0].lower()
    suffix = {"audio/mpeg": ".mp3", "audio/mp3": ".mp3", "audio/wav": ".wav",
              "audio/x-wav": ".wav", "audio/ogg": ".ogg", "audio/aac": ".aac",
              "audio/mp4": ".m4a", "audio/x-m4a": ".m4a"}.get(mime, ".bin")
    return mime, suffix, base64.b64decode(encoded, validate=True)


def write_media(directory, user_id, mime, suffix, data):
    media_id = str(uuid.uuid4())
    name = media_id + suffix
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = directory / ("." + media_id + ".tmp")
    target = directory / name
    try:
        with temporary.open("xb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.rename(target)
        directory_fd = os.open(directory, os.O_RDONLY)
        try:
            try:
                os.fsync(directory_fd)
            except OSError as exc:
                if exc.errno not in (errno.EINVAL, errno.ENOTSUP):
                    raise
        finally:
            os.close(directory_fd)
        return media_id, name, target, {
            "url": "/api/files/" + media_id + "/content",
            "storageKey": "server:" + media_id,
            "mimeType": mime,
            "bytes": len(data),
            "width": 0,
            "height": 0,
        }
    except Exception:
        temporary.unlink(missing_ok=True)
        target.unlink(missing_ok=True)
        raise


def migrate_row(db, directory, row):
    task_id, user_id, primary, others, response_body, existing_key, existing_storage = row
    urls = json.loads(others) if others and others != "null" else []
    if not isinstance(urls, list):
        raise ValueError("image_urls is not an array")
    if not urls:
        urls = [primary or ""]
    if not urls or any(not isinstance(url, str) for url in urls):
        raise ValueError("invalid image URLs")
    if primary and urls[0] != primary:
        raise ValueError("image_url and image_urls do not align")
    created = []
    cached = {}
    replacement = []
    storage = json.loads(existing_storage) if existing_storage else [None] * len(urls)
    if not isinstance(storage, list) or len(storage) != len(urls):
        storage = [None] * len(urls)
    if existing_key and not storage[0]:
        storage[0] = {"url": primary, "storageKey": existing_key, "mimeType": "", "bytes": 0, "width": 0, "height": 0}
    try:
        with db:
            for index, url in enumerate(urls):
                decoded = decode_image(url)
                if decoded is None:
                    replacement.append(url)
                    continue
                if url not in cached:
                    mime, suffix, data = decoded
                    media_id, name, target, info = write_media(directory, user_id, mime, suffix, data)
                    created.append(target)
                    db.execute(
                        "INSERT INTO storage_objects (id, provider_id, bucket, object_key, public_url, mime_type, bytes, width, height, sha256, direct, created_by, created_at, deleted_at) VALUES (?, 'local-generated', '', ?, '', ?, ?, 0, 0, ?, 0, ?, ?, '')",
                        (media_id, name, mime, len(data), hashlib.sha256(data).hexdigest(), user_id, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())),
                    )
                    cached[url] = info
                info = cached[url]
                replacement.append(info["url"])
                storage[index] = info
            changed = db.execute(
                "UPDATE canvas_image_tasks SET image_url = ?, image_urls = ?, image_storage = ?, storage_key = ?, response_body = '' WHERE id = ? AND image_url IS ? AND image_urls IS ? AND response_body IS ?",
                (replacement[0], json.dumps(replacement) if others else others, json.dumps(storage) if others else None,
                 storage[0]["storageKey"] if storage[0] else existing_key, task_id, primary, others, response_body),
            ).rowcount
            if changed != 1:
                raise ValueError("task changed while migrating")
    except Exception:
        for target in created:
            target.unlink(missing_ok=True)
        raise
    return len(created)


def migrate_audio_row(db, directory, row):
    task_id, user_id, url, response_body, existing_key = row
    created = None
    try:
        with db:
            decoded = decode_audio(url or "")
            if decoded:
                mime, suffix, data = decoded
                media_id, name, created, info = write_media(directory, user_id, mime, suffix, data)
                db.execute(
                    "INSERT INTO storage_objects (id, provider_id, bucket, object_key, public_url, mime_type, bytes, width, height, sha256, direct, created_by, created_at, deleted_at) VALUES (?, 'local-generated', '', ?, '', ?, ?, 0, 0, ?, 0, ?, ?, '')",
                    (media_id, name, mime, len(data), hashlib.sha256(data).hexdigest(), user_id, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())),
                )
                url, existing_key = info["url"], info["storageKey"]
            changed = db.execute(
                "UPDATE canvas_audio_tasks SET audio_url = ?, storage_key = ?, response_body = '' WHERE id = ? AND audio_url IS ? AND response_body IS ?",
                (url, existing_key, task_id, row[2], response_body),
            ).rowcount
            if changed != 1:
                raise ValueError("audio task changed while migrating")
    except Exception:
        if created:
            created.unlink(missing_ok=True)
        raise
    return int(created is not None)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--media-dir", type=Path, help="default: sibling generated-media directory")
    parser.add_argument("--apply", action="store_true", help="write local files and update SQLite")
    parser.add_argument("--backup", type=Path, help="required new database backup path for --apply")
    parser.add_argument("--writes-stopped", action="store_true", help="confirm application writes have stopped")
    parser.add_argument("--media-backup-confirmed", action="store_true", help="confirm existing media directory was backed up")
    parser.add_argument("--limit", type=int, default=0, help="maximum rows to process, 0 for all")
    args = parser.parse_args()
    database = args.db.resolve(strict=True)
    directory = (args.media_dir or database.parent / "generated-media").resolve()
    if args.apply:
        if not args.backup or not args.media_backup_confirmed or not args.writes_stopped:
            parser.error("--apply requires --backup, --writes-stopped and --media-backup-confirmed")
        backup = args.backup.resolve()
        if backup.exists() or backup == database or directory == database.parent:
            parser.error("backup must be new and media directory must not be the database directory")
        db = sqlite3.connect(database, timeout=30)
        columns = {item[1] for item in db.execute("PRAGMA table_info(canvas_image_tasks)")}
        if "image_storage" not in columns:
            parser.error("deploy new schema before offline apply: missing image_storage")
        if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            parser.error("source database quick_check failed; no rows changed")
        backup_fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(backup_fd)
        with sqlite3.connect(backup) as target:
            db.backup(target)
            if target.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                parser.error("backup quick_check failed; no rows changed")
    else:
        db = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
        columns = {item[1] for item in db.execute("PRAGMA table_info(canvas_image_tasks)")}
    storage_column = "image_storage" if "image_storage" in columns else "NULL AS image_storage"
    total = migrated = failed = media_count = audio_total = audio_migrated = 0
    bytes_inline = 0
    last_id = ""
    try:
        while not args.limit or total < args.limit:
            rows = db.execute(
                f"SELECT id, user_id, image_url, image_urls, response_body, storage_key, {storage_column} FROM canvas_image_tasks WHERE id > ? AND (image_url LIKE 'data:image/%' OR image_urls LIKE '%data:image/%' OR length(response_body) > 0) ORDER BY id LIMIT 20",
                (last_id,),
            ).fetchall()
            if not rows:
                break
            for row in rows:
                last_id = row[0]
                total += 1
                bytes_inline += len(row[2] or "") + len(row[3] or "") + len(row[4] or "")
                if args.apply:
                    try:
                        media_count += migrate_row(db, directory, row)
                        migrated += 1
                    except Exception as exc:
                        failed += 1
                        print(f"failed task {row[0]}: {exc}", file=sys.stderr)
                if args.limit and total >= args.limit:
                    break
        last_id = ""
        while not args.limit or audio_total < args.limit:
            rows = db.execute(
                "SELECT id, user_id, audio_url, response_body, storage_key FROM canvas_audio_tasks WHERE id > ? AND (audio_url LIKE 'data:audio/%' OR length(response_body) > 0) ORDER BY id LIMIT 20",
                (last_id,),
            ).fetchall()
            if not rows:
                break
            for row in rows:
                last_id = row[0]
                audio_total += 1
                bytes_inline += len(row[2] or "") + len(row[3] or "")
                if args.apply:
                    try:
                        media_count += migrate_audio_row(db, directory, row)
                        audio_migrated += 1
                    except Exception as exc:
                        failed += 1
                        print(f"failed audio task {row[0]}: {exc}", file=sys.stderr)
                if args.limit and audio_total >= args.limit:
                    break
        logs = db.execute("SELECT count(*), coalesce(sum(length(payload_json)), 0) FROM image_generation_logs").fetchone()
        all_object_ids = {row[0] for row in db.execute("SELECT id FROM storage_objects")}
        local_names = {row[0] for row in db.execute("SELECT object_key FROM storage_objects WHERE provider_id = 'local-generated'")}
        files = list(directory.iterdir()) if directory.is_dir() else []
        orphan_files = sum(1 for item in files if item.is_file() and item.name[:36] not in all_object_ids)
        missing_files = sum(1 for name in local_names if not (directory / name).is_file())
        print(json.dumps({"mode": "apply" if args.apply else "dry-run", "candidateTasks": total,
                          "migratedTasks": migrated, "audioCandidateTasks": audio_total, "audioMigratedTasks": audio_migrated,
                          "failedTasks": failed, "createdMedia": media_count,
                          "inlineTaskBytes": bytes_inline, "imageLogRows": logs[0], "imageLogBytes": logs[1],
                          "orphanMediaFiles": orphan_files, "missingLocalMediaFiles": missing_files}, ensure_ascii=False))
        if failed:
            return 1
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
