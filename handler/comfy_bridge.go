package handler

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/service"
)

func UserComfyBridges(w http.ResponseWriter, r *http.Request) {
	manageComfyBridges(w, r, "personal", "")
}
func AdminComfyBridges(w http.ResponseWriter, r *http.Request) {
	manageComfyBridges(w, r, "system", "system")
}

func manageComfyBridges(w http.ResponseWriter, r *http.Request, scope, ownerID string) {
	if scope == "personal" {
		user, ok := service.UserFromContext(r.Context())
		if !ok {
			FailWithStatus(w, http.StatusUnauthorized, "请先登录")
			return
		}
		ownerID = user.ID
	}
	if r.Method == http.MethodGet {
		items, err := service.ListComfyBridges(scope, ownerID)
		if err != nil {
			FailError(w, err)
			return
		}
		OK(w, items)
		return
	}
	var input struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&input); err != nil {
		Fail(w, "Bridge 注册参数无效")
		return
	}
	item, err := service.RegisterComfyBridge(scope, ownerID, input.Name)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, item)
}

func UserDeleteComfyBridge(w http.ResponseWriter, r *http.Request, id string) {
	deleteComfyBridge(w, r, "personal", "", id)
}
func AdminDeleteComfyBridge(w http.ResponseWriter, r *http.Request, id string) {
	deleteComfyBridge(w, r, "system", "system", id)
}

func UserComfyBridgeInspect(w http.ResponseWriter, r *http.Request) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		FailWithStatus(w, http.StatusUnauthorized, "请先登录")
		return
	}
	inspectComfyBridge(w, r, "personal", user.ID)
}

func AdminComfyBridgeInspect(w http.ResponseWriter, r *http.Request) {
	inspectComfyBridge(w, r, "system", "system")
}

func inspectComfyBridge(w http.ResponseWriter, r *http.Request, scope, ownerID string) {
	var input service.ComfyBridgeInspectInput
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 96<<20)).Decode(&input); err != nil {
		Fail(w, "Bridge 工作流检查参数无效")
		return
	}
	result, err := service.InspectComfyBridge(r.Context(), scope, ownerID, input)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

func deleteComfyBridge(w http.ResponseWriter, r *http.Request, scope, ownerID, id string) {
	if scope == "personal" {
		user, ok := service.UserFromContext(r.Context())
		if !ok {
			FailWithStatus(w, http.StatusUnauthorized, "请先登录")
			return
		}
		ownerID = user.ID
	}
	if err := service.DeleteComfyBridge(scope, ownerID, id); err != nil {
		FailError(w, err)
		return
	}
	OK(w, map[string]bool{"deleted": true})
}

func BridgeComfyHeartbeat(w http.ResponseWriter, r *http.Request) {
	bridge, ok := authenticateComfyBridge(w, r)
	if !ok {
		return
	}
	var input struct {
		Capabilities map[string]any `json:"capabilities"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<20)).Decode(&input); err != nil {
		Fail(w, "Bridge 心跳参数无效")
		return
	}
	if err := service.HeartbeatComfyBridge(bridge, input.Capabilities); err != nil {
		FailError(w, err)
		return
	}
	OK(w, map[string]bool{"accepted": true})
}

func BridgeComfyPoll(w http.ResponseWriter, r *http.Request) {
	bridge, ok := authenticateComfyBridge(w, r)
	if !ok {
		return
	}
	cleanupAcknowledged := false
	cleanupRequestID := strings.TrimSpace(r.URL.Query().Get("cleanupRequestId"))
	cleanupLeaseToken := strings.TrimSpace(r.URL.Query().Get("cleanupLeaseToken"))
	if cleanupRequestID != "" || cleanupLeaseToken != "" {
		if cleanupRequestID == "" || cleanupLeaseToken == "" {
			Fail(w, "Bridge 清理确认参数无效")
			return
		}
		var err error
		cleanupAcknowledged, err = service.ConfirmComfyBridgeResultCleanup(
			bridge,
			cleanupRequestID,
			cleanupLeaseToken,
		)
		if err != nil {
			if errors.Is(err, service.ErrComfyBridgeLeaseLost) {
				FailWithStatus(w, http.StatusConflict, err.Error())
				return
			}
			FailError(w, err)
			return
		}
	}
	queue := strings.TrimSpace(r.URL.Query().Get("queue"))
	if queue != "inspect" {
		queue = "execute"
	}
	deadline := time.NewTimer(20 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		job, err := service.PollComfyBridge(bridge, queue)
		if err != nil {
			FailError(w, err)
			return
		}
		if job != nil {
			OK(w, map[string]any{
				"request":             job,
				"cleanupAcknowledged": cleanupAcknowledged,
			})
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-deadline.C:
			OK(w, map[string]any{
				"request":             nil,
				"cleanupAcknowledged": cleanupAcknowledged,
			})
			return
		case <-ticker.C:
		}
	}
}

func BridgeComfyLease(w http.ResponseWriter, r *http.Request) {
	bridge, ok := authenticateComfyBridge(w, r)
	if !ok {
		return
	}
	var input struct {
		RequestID  string         `json:"requestId"`
		LeaseToken string         `json:"leaseToken"`
		Checkpoint map[string]any `json:"checkpoint,omitempty"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&input); err != nil {
		Fail(w, "Bridge 租约参数无效")
		return
	}
	leaseExpiresAt, accepted, err := service.RenewComfyBridgeLease(
		bridge,
		input.RequestID,
		input.LeaseToken,
		input.Checkpoint,
	)
	if err != nil {
		FailError(w, err)
		return
	}
	if !accepted {
		FailWithStatus(w, http.StatusConflict, "Bridge 请求租约已失效")
		return
	}
	OK(w, map[string]any{
		"accepted":       accepted,
		"leaseExpiresAt": leaseExpiresAt,
	})
}

func BridgeComfyResult(w http.ResponseWriter, r *http.Request) {
	bridge, ok := authenticateComfyBridge(w, r)
	if !ok {
		return
	}
	var input struct {
		RequestID  string         `json:"requestId"`
		LeaseToken string         `json:"leaseToken"`
		Status     string         `json:"status"`
		Result     map[string]any `json:"result"`
		Error      string         `json:"error"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 129<<20)).Decode(&input); err != nil {
		Fail(w, "Bridge 结果参数无效")
		return
	}
	acknowledged, err := service.CompleteComfyBridge(
		bridge,
		input.RequestID,
		input.LeaseToken,
		input.Status,
		input.Result,
		input.Error,
	)
	if err != nil {
		if errors.Is(err, service.ErrComfyBridgeLeaseLost) {
			FailWithStatus(w, http.StatusConflict, err.Error())
			return
		}
		FailError(w, err)
		return
	}
	OK(w, map[string]bool{"acknowledged": acknowledged})
}

// BridgeComfyMedia accepts a result from the Bridge host. The Bridge reads
// localhost-only ComfyUI output and uploads bytes here before completing the
// task, so the server never follows a Bridge-local URL.
func BridgeComfyMedia(w http.ResponseWriter, r *http.Request) {
	bridge, ok := authenticateComfyBridge(w, r)
	if !ok {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 130<<20)
	if err := r.ParseMultipartForm(2 << 20); err != nil {
		Fail(w, "Bridge 媒体参数无效或超过 128MB")
		return
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		Fail(w, "Bridge 媒体文件缺失")
		return
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, (128<<20)+1))
	if err != nil || len(data) == 0 || len(data) > 128<<20 {
		Fail(w, "Bridge 媒体无效或超过 128MB")
		return
	}
	stored, err := service.SaveComfyBridgeMedia(
		bridge,
		r.FormValue("requestId"),
		r.FormValue("leaseToken"),
		r.FormValue("resultId"),
		header.Filename,
		header.Header.Get("Content-Type"),
		data,
	)
	if err != nil {
		if errors.Is(err, service.ErrComfyBridgeLeaseLost) {
			FailWithStatus(w, http.StatusConflict, err.Error())
		} else {
			FailError(w, err)
		}
		return
	}
	response := map[string]any{
		"id": stored.ID, "url": stored.URL, "storageKey": stored.StorageKey,
		"bytes": stored.Bytes, "mimeType": stored.MimeType,
	}
	requestID := r.FormValue("requestId")
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		if syncErr := service.SyncComfyBridgeMediaForRequest(ctx, bridge, requestID, stored.ID); syncErr != nil {
			// The local object is already durable; cloud promotion can be retried
			// later without invalidating the result returned to the Bridge.
			log.Printf("sync Comfy Bridge media failed request=%s object=%s err=%v", requestID, stored.ID, syncErr)
		}
	}()
	OK(w, response)
}

func authenticateComfyBridge(w http.ResponseWriter, r *http.Request) (model.ComfyBridge, bool) {
	token := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	bridge, err := service.AuthenticateComfyBridge(token)
	if err != nil {
		FailWithStatus(w, http.StatusUnauthorized, "Bridge Token 无效")
		return model.ComfyBridge{}, false
	}
	return bridge, true
}
