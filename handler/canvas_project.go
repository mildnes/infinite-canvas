package handler

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/tigerowo/infinite-canvas/service"
)

func UserCanvasProjects(w http.ResponseWriter, r *http.Request) {
	projects, err := service.CurrentUserCanvasProjects(r.Context())
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, projects)
}

func SaveUserCanvasProject(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Data          json.RawMessage `json:"data"`
		BaseUpdatedAt *string         `json:"baseUpdatedAt"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil ||
		len(request.Data) == 0 {
		Fail(w, "数据内容不能为空")
		return
	}

	var base []string
	if request.BaseUpdatedAt != nil {
		base = append(base, *request.BaseUpdatedAt)
	}
	project, err := service.SaveCurrentUserCanvasProject(
		r.Context(),
		request.Data,
		base...,
	)
	if err != nil {
		failCanvasProjectSave(w, err)
		return
	}
	OK(w, project)
}

func SyncUserCanvasProjects(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Projects       []json.RawMessage `json:"projects"`
		BaseUpdatedAts map[string]string `json:"baseUpdatedAts"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		Fail(w, "画布项目参数无效")
		return
	}

	projects, err := service.SyncCurrentUserCanvasProjects(
		r.Context(),
		request.Projects,
		request.BaseUpdatedAts,
	)
	if err != nil {
		failCanvasProjectSave(w, err)
		return
	}
	OK(w, projects)
}

func failCanvasProjectSave(w http.ResponseWriter, err error) {
	var conflict *service.CanvasProjectConflictError
	if errors.As(err, &conflict) {
		writeJSONWithStatus(w, http.StatusConflict, response{Code: 1, Data: map[string]any{"currentProject": conflict.CurrentProject}, Msg: err.Error()})
		return
	}
	FailError(w, err)
}
