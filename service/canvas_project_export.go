package service

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
	"gorm.io/gorm"
)

const CanvasProjectExportTimeout = 10 * time.Minute
const canvasExportTicketLifetime = 5 * time.Minute

var ErrCanvasExportTicket = errors.New("导出票据无效或已过期，请重新导出")

type CanvasProjectExportTicket struct {
	Mode            string     `json:"mode"`
	URL             string     `json:"url,omitempty"`
	ExpiresAt       *time.Time `json:"expiresAt,omitempty"`
	LocalAssetCount int        `json:"localAssetCount,omitempty"`
}

type canvasExportClaims struct {
	ProjectID string `json:"projectId"`
	jwt.RegisteredClaims
}

// Only small nonces live in memory. Restarting the process invalidates tickets,
// and consuming a nonce atomically prevents concurrent replay without a DB table.
var canvasExportTickets = struct {
	sync.Mutex
	pending map[string]time.Time
}{pending: make(map[string]time.Time)}

func CreateCanvasProjectExportTicket(ctx context.Context, id string) (CanvasProjectExportTicket, error) {
	raw, err := CurrentUserCanvasProject(ctx, id)
	if err != nil {
		return CanvasProjectExportTicket{}, err
	}
	var project any
	if err := json.Unmarshal(raw, &project); err != nil {
		return CanvasProjectExportTicket{}, err
	}
	if keys := canvasExportLocalMediaKeys(project); len(keys) > 0 {
		return CanvasProjectExportTicket{Mode: "browser", LocalAssetCount: len(keys)}, nil
	}
	user, _ := UserFromContext(ctx)
	current := time.Now().UTC()
	expires := current.Add(canvasExportTicketLifetime).Truncate(time.Second)
	claims := canvasExportClaims{
		ProjectID: id,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject: user.ID, Audience: jwt.ClaimStrings{"canvas-export"}, ID: uuid.NewString(),
			IssuedAt: jwt.NewNumericDate(current), ExpiresAt: jwt.NewNumericDate(expires),
		},
	}
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(config.Cfg.JWTSecret))
	if err != nil {
		return CanvasProjectExportTicket{}, err
	}
	canvasExportTickets.Lock()
	defer canvasExportTickets.Unlock()
	for nonce, expiry := range canvasExportTickets.pending {
		if !expiry.After(current) {
			delete(canvasExportTickets.pending, nonce)
		}
	}
	if len(canvasExportTickets.pending) >= 4096 {
		return CanvasProjectExportTicket{}, safeMessageError{message: "导出请求较多，请稍后重试"}
	}
	canvasExportTickets.pending[claims.ID] = expires
	return CanvasProjectExportTicket{
		Mode:      "server",
		URL:       "/api/v1/canvas/projects/" + url.PathEscape(id) + "/export?ticket=" + url.QueryEscape(token),
		ExpiresAt: &expires,
	}, nil
}

// canvasExportLocalMediaKeys collects media references the browser media stores own. Only
// "server:" keys live in object storage; the browser exporter treats every other storageKey as
// local, so they must select browser export rather than being silently dropped server-side.
func canvasExportLocalMediaKeys(project any) []string {
	keys := make(map[string]struct{})
	var visit func(any)
	visit = func(value any) {
		switch item := value.(type) {
		case map[string]any:
			for key, child := range item {
				if key == "storageKey" {
					if storageKey, ok := child.(string); ok {
						if strings.Contains(storageKey, ":") && !strings.HasPrefix(storageKey, "server:") {
							keys[storageKey] = struct{}{}
						}
					}
				}
				visit(child)
			}
		case []any:
			for _, child := range item {
				visit(child)
			}
		}
	}
	visit(project)
	ordered := make([]string, 0, len(keys))
	for key := range keys {
		ordered = append(ordered, key)
	}
	sort.Strings(ordered)
	return ordered
}

type canvasExportAsset struct {
	StorageKey string `json:"storageKey"`
	Path       string `json:"path"`
	MimeType   string `json:"mimeType"`
	Bytes      int64  `json:"bytes"`
}

type canvasExportMissing struct {
	StorageKey string `json:"storageKey"`
	Reason     string `json:"reason"`
}

type CanvasProjectExport struct {
	Title   string
	userID  string
	project json.RawMessage
	files   []canvasExportAsset
	missing []canvasExportMissing
}

func OpenCanvasProjectExport(ctx context.Context, id, ticket string) (*CanvasProjectExport, error) {
	claims := &canvasExportClaims{}
	_, err := jwt.ParseWithClaims(ticket, claims, func(_ *jwt.Token) (any, error) {
		return []byte(config.Cfg.JWTSecret), nil
	}, jwt.WithValidMethods([]string{"HS256"}), jwt.WithExpirationRequired(), jwt.WithAudience("canvas-export"))
	if err != nil || claims.Subject == "" || claims.ID == "" || claims.ProjectID != id {
		return nil, ErrCanvasExportTicket
	}
	canvasExportTickets.Lock()
	expiry, issued := canvasExportTickets.pending[claims.ID]
	delete(canvasExportTickets.pending, claims.ID)
	canvasExportTickets.Unlock()
	if !issued || !expiry.After(time.Now()) {
		return nil, ErrCanvasExportTicket
	}
	raw, err := CurrentUserCanvasProject(WithUser(ctx, model.AuthUser{ID: claims.Subject}), id)
	if err != nil {
		return nil, err
	}
	return prepareCanvasProjectExport(ctx, claims.Subject, id, raw)
}

func prepareCanvasProjectExport(ctx context.Context, userID, id string, raw json.RawMessage) (*CanvasProjectExport, error) {
	var project any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&project); err != nil {
		return nil, err
	}
	result := &CanvasProjectExport{userID: userID, files: []canvasExportAsset{}, Title: "未命名画布"}
	for _, key := range canvasExportLocalMediaKeys(project) {
		result.missing = append(result.missing, canvasExportMissing{
			StorageKey: key, Reason: "本地素材无法通过服务端票据导出，请在浏览器中导出",
		})
	}
	keys := make(map[string]bool)
	var visit func(any, string) any
	visit = func(value any, location string) any {
		switch item := value.(type) {
		case map[string]any:
			for key, child := range item {
				item[key] = visit(child, location+"/"+key)
			}
		case []any:
			for index, child := range item {
				item[index] = visit(child, fmt.Sprintf("%s/%d", location, index))
			}
		case string:
			if strings.HasPrefix(item, "server:") {
				keys[item] = true
			}
			if strings.HasPrefix(strings.TrimSpace(item), "data:") {
				result.missing = append(result.missing, canvasExportMissing{
					StorageKey: "inline:" + location, Reason: "内联媒体未存入对象存储，未包含在导出中",
				})
				return ""
			}
		}
		return value
	}
	project = visit(project, id)
	if data, ok := project.(map[string]any); ok {
		if title, ok := data["title"].(string); ok && strings.TrimSpace(title) != "" {
			result.Title = title
		}
	}
	encoded, err := json.Marshal(project)
	if err != nil {
		return nil, err
	}
	result.project = encoded
	ordered := make([]string, 0, len(keys))
	for key := range keys {
		ordered = append(ordered, key)
	}
	sort.Strings(ordered)
	for _, key := range ordered {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		object, err := repository.GetStorageObject(strings.TrimPrefix(key, "server:"))
		if errors.Is(err, gorm.ErrRecordNotFound) || (err == nil && object.DeletedAt != "") {
			result.missing = append(result.missing, canvasExportMissing{key, "文件不存在或已删除"})
			continue
		}
		if err != nil {
			return nil, err
		}
		if object.CreatedBy != userID {
			result.missing = append(result.missing, canvasExportMissing{key, "文件不属于当前账号"})
			continue
		}
		mimeType := object.MimeType
		if mimeType == "" {
			mimeType = "application/octet-stream"
		}
		result.files = append(result.files, canvasExportAsset{
			StorageKey: key,
			Path: "projects/" + canvasExportFileName(id) + "/files/" +
				canvasExportFileName(object.ID) + "." + canvasExportExtension(mimeType),
			MimeType: mimeType, Bytes: object.Bytes,
		})
	}
	return result, nil
}

func canvasExportFileName(value string) string {
	value = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || strings.ContainsRune(`\/:*?"<>|`, r) {
			return '_'
		}
		return r
	}, value)
	if strings.TrimSpace(value) == "" || value == "." || value == ".." {
		return "_"
	}
	return value
}

func (export *CanvasProjectExport) FileName() string {
	return canvasExportFileName(export.Title) + "-" + time.Now().Format("20060102-1504") + ".zip"
}

func canvasExportExtension(mimeType string) string {
	for _, item := range []struct{ mime, extension string }{
		{"png", "png"}, {"jpeg", "jpg"}, {"webp", "webp"},
		{"gif", "gif"}, {"mp4", "mp4"}, {"webm", "webm"},
	} {
		if strings.Contains(mimeType, item.mime) {
			return item.extension
		}
	}
	return "bin"
}

type canvasExportOutput struct {
	ctx context.Context
	out io.Writer
	err error
}

func (out *canvasExportOutput) Write(data []byte) (int, error) {
	if err := out.ctx.Err(); err != nil {
		return 0, err
	}
	n, err := out.out.Write(data)
	if err != nil {
		out.err = err
	}
	return n, err
}

func (export *CanvasProjectExport) Write(ctx context.Context, out io.Writer) error {
	ctx = WithUser(ctx, model.AuthUser{ID: export.userID})
	return export.write(ctx, out, DownloadOwnedStorageObject)
}

func (export *CanvasProjectExport) write(ctx context.Context, out io.Writer, download func(context.Context, string, string) (DownloadedStorageObject, error)) error {
	ctx, cancel := context.WithTimeout(ctx, CanvasProjectExportTimeout)
	defer cancel()
	output := &canvasExportOutput{ctx: ctx, out: out}
	archive := zip.NewWriter(output)
	writeJSON := func(name string, value any) error {
		entry, err := archive.Create(name)
		if err != nil {
			return err
		}
		return json.NewEncoder(entry).Encode(value)
	}
	manifest := struct {
		App        string `json:"app"`
		Version    int    `json:"version"`
		ExportedAt string `json:"exportedAt"`
		Projects   []struct {
			Project json.RawMessage     `json:"project"`
			Files   []canvasExportAsset `json:"files"`
		} `json:"projects"`
	}{App: "infinite-canvas", Version: 3, ExportedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	manifest.Projects = append(manifest.Projects, struct {
		Project json.RawMessage     `json:"project"`
		Files   []canvasExportAsset `json:"files"`
	}{export.project, export.files})
	if err := writeJSON("projects.json", manifest); err != nil {
		return err
	}
	// Flush the small manifest before opening slow object storage.
	if err := archive.Flush(); err != nil {
		return err
	}
	if flusher, ok := out.(interface{ Flush() }); ok {
		flusher.Flush()
	}
	missing := append([]canvasExportMissing(nil), export.missing...)
	for _, asset := range export.files {
		if err := ctx.Err(); err != nil {
			return err
		}
		id := strings.TrimPrefix(asset.StorageKey, "server:")
		// Recheck immediately before opening a stream; ownership may have changed
		// after the manifest was prepared. Never open a known foreign object.
		object, err := repository.GetStorageObject(id)
		if err != nil || object.DeletedAt != "" || object.CreatedBy != export.userID {
			missing = append(missing, canvasExportMissing{asset.StorageKey, "文件不可用或不属于当前账号"})
			continue
		}
		stream, err := download(ctx, id, "")
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			missing = append(missing, canvasExportMissing{asset.StorageKey, "文件读取失败"})
			continue
		}
		if stream.Stream == nil {
			missing = append(missing, canvasExportMissing{asset.StorageKey, "文件读取失败"})
			continue
		}
		if stream.Object.CreatedBy != export.userID || stream.Object.DeletedAt != "" {
			_ = stream.Stream.Close()
			missing = append(missing, canvasExportMissing{asset.StorageKey, "文件不属于当前账号或已删除"})
			continue
		}
		stopClose := context.AfterFunc(ctx, func() { _ = stream.Stream.Close() })
		entry, err := archive.CreateHeader(&zip.FileHeader{Name: asset.Path, Method: zip.Store})
		if err != nil {
			stopClose()
			_ = stream.Stream.Close()
			return err
		}
		copied, err := io.Copy(entry, stream.Stream)
		stopClose()
		_ = stream.Stream.Close()
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if output.err != nil {
			return output.err
		}
		if err != nil || copied != asset.Bytes {
			missing = append(missing, canvasExportMissing{asset.StorageKey, "文件读取不完整"})
		}
	}
	if len(missing) > 0 {
		if err := writeJSON("missing.json", missing); err != nil {
			return err
		}
	}
	if err := archive.Close(); err != nil {
		return err
	}
	log.Printf("canvas_export completed files=%d missing=%d", len(export.files), len(missing))
	return nil
}
