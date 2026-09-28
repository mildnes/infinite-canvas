package service

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

// SaveComfyBridgeMedia validates the active Bridge lease before accepting a
// binary result. The Bridge host can therefore upload localhost ComfyUI
// outputs without asking the server to make an unsafe callback to 127.0.0.1.
func SaveComfyBridgeMedia(bridge model.ComfyBridge, requestID, leaseToken, resultID, filename, contentType string, data []byte) (UploadedStorageObject, error) {
	requestID = strings.TrimSpace(requestID)
	leaseToken = strings.TrimSpace(leaseToken)
	resultID = strings.TrimSpace(resultID)
	if requestID == "" || leaseToken == "" || !validWorkflowResultID(resultID) || len(data) == 0 || int64(len(data)) > workflowResultMediaLimit {
		return UploadedStorageObject{}, errors.New("Bridge 媒体参数无效或超过 128MB")
	}
	request, err := repository.GetComfyBridgeRequest(requestID)
	if err != nil {
		return UploadedStorageObject{}, err
	}
	if request.BridgeID != bridge.ID || request.OwnerScope != bridge.OwnerScope || request.OwnerID != bridge.OwnerID || request.Status != "claimed" || request.LeaseToken != leaseToken || request.LeaseExpiresAt == nil || !time.Now().Before(*request.LeaseExpiresAt) {
		return UploadedStorageObject{}, ErrComfyBridgeLeaseLost
	}
	userID := strings.TrimSpace(request.OwnerID)
	if request.OwnerScope == "system" {
		userID, err = repository.LookupWorkflowTaskUserID(request.TaskID)
		if err != nil {
			return UploadedStorageObject{}, err
		}
	}
	contentType = strings.TrimSpace(strings.Split(contentType, ";")[0])
	if contentType == "" || contentType == "application/octet-stream" {
		contentType = workflowResultMIMEFromPath(filename)
		if contentType == "" {
			contentType = strings.TrimSpace(http.DetectContentType(data))
		}
	}
	if !isWorkflowResultMIME(contentType) {
		return UploadedStorageObject{}, errors.New("Bridge 媒体类型不受支持")
	}
	if err := ValidateGeneratedMediaBytes(data, contentType); err != nil {
		return UploadedStorageObject{}, err
	}
	return SaveGeneratedMediaDeduplicated(userID, contentType, data, "")
}

func validWorkflowResultID(value string) bool {
	if len(value) < 16 || len(value) > 128 {
		return false
	}
	for _, char := range value {
		if (char < 'a' || char > 'f') && (char < 'A' || char > 'F') && (char < '0' || char > '9') && char != '-' && char != '_' {
			return false
		}
	}
	return true
}

// SyncComfyBridgeMedia performs optional cloud promotion after the local
// object has been indexed. A failed upload is returned for logging while the
// caller keeps the local short URL usable.
func SyncComfyBridgeMedia(ctx context.Context, userID, objectID string) error {
	return SyncGeneratedMediaForUser(ctx, userID, objectID)
}

func SyncComfyBridgeMediaForRequest(ctx context.Context, bridge model.ComfyBridge, requestID, objectID string) error {
	request, err := repository.GetComfyBridgeRequest(strings.TrimSpace(requestID))
	if err != nil {
		return err
	}
	if request.BridgeID != bridge.ID || request.OwnerScope != bridge.OwnerScope || request.OwnerID != bridge.OwnerID {
		return ErrComfyBridgeLeaseLost
	}
	userID := request.OwnerID
	if request.OwnerScope == "system" {
		userID, err = repository.LookupWorkflowTaskUserID(request.TaskID)
		if err != nil {
			return err
		}
	}
	return SyncGeneratedMediaForUser(ctx, userID, objectID)
}
