package handler

import (
	"crypto/sha256"
	"errors"
	"fmt"
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
		w.Header().Set("Cache-Control", "no-store")
		http.NotFound(w, r)
		return
	}
	var header [512]byte
	n, err := file.ReadAt(header[:], 0)
	if err != nil && err != io.EOF {
		w.Header().Set("Cache-Control", "no-store")
		http.NotFound(w, r)
		return
	}
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		w.Header().Set("Cache-Control", "no-store")
		http.NotFound(w, r)
		return
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		w.Header().Set("Cache-Control", "no-store")
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", http.DetectContentType(header[:n]))
	w.Header().Set("ETag", fmt.Sprintf(`"%x"`, digest.Sum(nil)))
	w.Header().Set("Cache-Control", "public, max-age=300, must-revalidate")
	http.ServeContent(w, r, info.Name(), info.ModTime(), file)
}

func PutFilePreview(w http.ResponseWriter, r *http.Request, id string) {
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, service.StoragePreviewPNGMaxBytes))
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
