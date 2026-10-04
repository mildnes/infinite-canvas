package handler

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/service"
)

type imageOutputValidationSkipped struct{}

func canvasTaskRequestsTransparentPNG(task model.CanvasImageTask) bool {
	var metadata map[string]any
	return json.Unmarshal([]byte(task.RequestBody), &metadata) == nil && metadata["_image_output_format"] == string(model.ImageOutputFormatPNGTransparent)
}

// Transparent image results are inspected before committing response headers.
// Protocol adapters still own their payloads, polling, billing and failures.
func copyValidatedImageResponse(w http.ResponseWriter, request *http.Request, channel model.ModelChannel, logContext aiLogContext, onFailure func()) {
	recorder := httptest.NewRecorder()
	innerContext := logContext
	innerContext.SkipLog = true
	request = request.WithContext(context.WithValue(request.Context(), imageOutputValidationSkipped{}, true))
	copyAIResponse(recorder, request, channel, innerContext, onFailure)
	payload := recorder.Body.Bytes()
	errMessage := readWrappedTaskError(payload)
	if recorder.Code < http.StatusBadRequest && errMessage == "" {
		if notice, code := validateImageResponseAlpha(request.Context(), payload, recorder.Header().Get("Content-Type")); notice != "" {
			logContext.ImageOutputNotice = notice
			logContext.ImageOutputNoticeCode = code
			recorder.Header().Set("X-Image-Output-Notice", code)
			log.Printf("image output warning: channel=%s model=%s notice=%s", channel.ID, logContext.Model, code)
		}
	}
	for key, values := range recorder.Header() {
		if strings.EqualFold(key, "Content-Length") {
			continue
		}
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}
	w.WriteHeader(recorder.Code)
	_, _ = io.Copy(w, recorder.Body)
	saveAIProxyLog(logContext, recorder.Code, boundedTaskError(string(payload), 64*1024), errMessage)
}

func validateImageResponseAlpha(ctx context.Context, payload []byte, contentType string) (string, string) {
	urls, _, _, err := imageURLsFromAIResponse(payload, contentType, true, true)
	if err != nil {
		return "上游图片透明通道无法验证。", "upstream-alpha-unverified"
	}
	unverified := len(urls) == 0
	for _, raw := range urls {
		media, err := service.ReadTrustedGeneratedMedia(ctx, raw)
		if err != nil {
			unverified = true
			continue
		}
		alpha, err := service.PNGHasAlpha(media.Data)
		if err != nil {
			unverified = true
			continue
		}
		if !alpha {
			return "上游未返回透明通道。", "upstream-no-alpha"
		}
	}
	if unverified {
		return "上游图片透明通道无法验证。", "upstream-alpha-unverified"
	}
	return "", ""
}
