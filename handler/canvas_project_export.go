package handler

import (
	"context"
	"errors"
	"log"
	"mime"
	"net/http"
	"time"

	"github.com/tigerowo/infinite-canvas/service"
	"gorm.io/gorm"
)

func CreateCanvasProjectExport(w http.ResponseWriter, r *http.Request, id string) {
	w.Header().Set("Cache-Control", "no-store")
	ticket, err := service.CreateCanvasProjectExportTicket(r.Context(), id)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		FailWithStatus(w, http.StatusNotFound, "画布不存在")
		return
	}
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, ticket)
}

func DownloadCanvasProjectExport(w http.ResponseWriter, r *http.Request, id string) {
	ctx, cancel := context.WithTimeout(r.Context(), service.CanvasProjectExportTimeout)
	defer cancel()
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	export, err := service.OpenCanvasProjectExport(ctx, id, r.URL.Query().Get("ticket"))
	if errors.Is(err, service.ErrCanvasExportTicket) {
		FailWithStatus(w, http.StatusForbidden, err.Error())
		return
	}
	if errors.Is(err, gorm.ErrRecordNotFound) {
		FailWithStatus(w, http.StatusNotFound, "画布不存在")
		return
	}
	if err != nil {
		FailError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": export.FileName()}))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Accel-Buffering", "no")
	w.Header().Del("Content-Length")
	if deadline, ok := ctx.Deadline(); ok {
		controller := http.NewResponseController(w)
		if controller.SetWriteDeadline(deadline) == nil {
			defer controller.SetWriteDeadline(time.Time{})
		}
	}
	if err := export.Write(ctx, w); err != nil {
		// ZIP headers have already been sent; never append a JSON error to it.
		log.Printf("canvas_export interrupted project=%s err=%v context=%v", id, err, ctx.Err())
	}
}
