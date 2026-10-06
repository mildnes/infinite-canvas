package handler

import (
	"errors"
	"io"
	"net/http"
	"os"

	"github.com/tigerowo/infinite-canvas/service"
	"gorm.io/gorm"
)

func FilePreview(w http.ResponseWriter, r *http.Request, id string) {
	file, err := service.OpenStoragePreview(id)
	serveFilePreview(w, r, file, err)
}

func serveFilePreview(w http.ResponseWriter, r *http.Request, file *os.File, openErr error) {
	if openErr != nil {
		w.Header().Set("Cache-Control", "no-store")
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	http.ServeContent(w, r, info.Name(), info.ModTime(), file)
}

func PutFilePreview(w http.ResponseWriter, r *http.Request, id string) {
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, service.StoragePreviewMaxBytes))
	if err != nil {
		FailWithStatus(w, http.StatusBadRequest, "预览超过大小限制")
		return
	}
	if err := service.SubmitStoragePreview(r.Context(), id, data); err != nil {
		switch {
		case errors.Is(err, service.ErrStoragePreviewForbidden):
			FailWithStatus(w, http.StatusForbidden, err.Error())
		case errors.Is(err, service.ErrStoragePreviewInvalid):
			FailWithStatus(w, http.StatusBadRequest, err.Error())
		case errors.Is(err, gorm.ErrRecordNotFound):
			FailWithStatus(w, http.StatusNotFound, "对象不存在")
		default:
			FailWithStatus(w, http.StatusInternalServerError, "预览缓存提交失败")
		}
		return
	}
	OK(w, true)
}
