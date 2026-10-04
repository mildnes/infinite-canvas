#!/usr/bin/env python3
"""Request transparent PNG from an Images endpoint and verify actual pixels.

Requires Pillow. Set IMAGE_PROBE_API_KEY in the environment; credentials and
response bodies are never printed. --file checks a previously returned image.
"""

import argparse
import base64
import hashlib
import io
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

from PIL import Image

MEDIA_LIMIT = 128 << 20


def read_response(request, timeout):
    with urllib.request.urlopen(request, timeout=timeout) as response:
        data = response.read(MEDIA_LIMIT + 1)
        if len(data) > MEDIA_LIMIT:
            raise ValueError("response exceeds 128 MiB")
        return data, response.headers.get("X-Image-Output-Notice", "")


def result_sources(payload):
    if isinstance(payload, dict):
        if "code" in payload and payload["code"] != 0:
            raise ValueError("generation API returned an error")
        if isinstance(payload.get("b64_json"), str):
            yield "base64", payload["b64_json"]
        elif isinstance(payload.get("url"), str):
            yield "url", payload["url"]
        elif payload.get("type") == "image_generation_call" and isinstance(payload.get("result"), str):
            yield "base64", payload["result"]
        else:
            for name in ("data", "output", "images"):
                if name in payload:
                    yield from result_sources(payload[name])
    elif isinstance(payload, list):
        for item in payload:
            yield from result_sources(item)


def image_bytes(kind, value, endpoint, key, timeout):
    if kind == "base64":
        return base64.b64decode(value, validate=True)
    if value.startswith("data:"):
        return base64.b64decode(value.split(",", 1)[1], validate=True)
    url = urllib.parse.urljoin(endpoint, value)
    if urllib.parse.urlsplit(url).scheme not in ("http", "https"):
        raise ValueError("unsupported image URL")
    headers = {}
    if key and urllib.parse.urlsplit(url).netloc == urllib.parse.urlsplit(endpoint).netloc:
        headers["Authorization"] = "Bearer " + key
    return read_response(urllib.request.Request(url, headers=headers), timeout)[0]


def inspect_png(data, index):
    Image.MAX_IMAGE_PIXELS = 40_000_000
    with Image.open(io.BytesIO(data)) as image:
        if image.format != "PNG":
            raise ValueError("result is not PNG")
        image.load()
        alpha = image.convert("RGBA").getchannel("A").histogram()
        pixels = image.width * image.height
        report = {
            "image": index, "format": image.format, "mode": image.mode,
            "width": image.width, "height": image.height, "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "transparentPixels": alpha[0], "transparentFraction": round(alpha[0] / pixels, 6),
        }
        report["passed"] = alpha[0] > 0
        return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--endpoint", help="exact Images generations URL")
    source.add_argument("--file", help="validate an existing image without generating")
    parser.add_argument("--model")
    parser.add_argument("--channel-id", help="application X-Model-Channel-ID, when using its proxy")
    parser.add_argument("--size")
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--out", help="optional new PNG path; never overwrites an existing file")
    args = parser.parse_args()
    notice = ""
    if args.file:
        with open(args.file, "rb") as file:
            results = [file.read(MEDIA_LIMIT + 1)]
    else:
        if not args.model:
            parser.error("--model is required with --endpoint")
        key = os.environ.get("IMAGE_PROBE_API_KEY", "")
        body = {
            "model": args.model, "n": 1, "response_format": "b64_json",
            "output_format": "png", "background": "transparent",
            "prompt": "A single simple red apple centered on a fully transparent background. No shadow, no backdrop, no checkerboard drawn into the image. PNG with transparent alpha outside the apple.",
        }
        if args.size:
            body["size"] = args.size
        headers = {"Content-Type": "application/json"}
        if key:
            headers["Authorization"] = "Bearer " + key
        if args.channel_id:
            headers["X-Model-Channel-ID"] = args.channel_id
        request = urllib.request.Request(args.endpoint, data=json.dumps(body).encode(), headers=headers)
        payload, notice = read_response(request, args.timeout)
        sources = list(result_sources(json.loads(payload)))
        if not sources:
            raise ValueError("response contains no completed image result")
        results = [image_bytes(kind, value, args.endpoint, key, args.timeout) for kind, value in sources]
    reports = []
    for index, data in enumerate(results):
        if len(data) > MEDIA_LIMIT:
            raise ValueError("image exceeds 128 MiB")
        reports.append(inspect_png(data, index))
    passed = all(report["passed"] for report in reports)
    if args.out:
        if len(results) != 1:
            raise ValueError("--out requires exactly one result")
        with open(args.out, "xb") as file:
            file.write(results[0])
    print(json.dumps({"passed": passed, "notice": notice, "images": reports}, ensure_ascii=False))
    return 0 if passed else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except urllib.error.HTTPError as error:
        print(json.dumps({"passed": False, "error": "HTTP " + str(error.code)}))
        sys.exit(1)
    except Exception as error:
        print(json.dumps({"passed": False, "error": str(error)}))
        sys.exit(1)
