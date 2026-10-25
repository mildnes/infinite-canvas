package service

import (
	"encoding/json"
	"strings"

	"github.com/tigerowo/infinite-canvas/repository"
)

// Repair only missing media for the exact original run. RawMessage preserves unknown
// fields/large integers; layout, existing media, explicit failures and stopped runs are untouched.
func recoverCanvasImageResults(userID string, raw json.RawMessage) (json.RawMessage, error) {
	var project map[string]json.RawMessage
	if err := json.Unmarshal(raw, &project); err != nil {
		return nil, err
	}
	var projectID string
	_ = json.Unmarshal(project["id"], &projectID)
	if len(project["nodes"]) == 0 {
		return raw, nil
	}
	var nodes []map[string]json.RawMessage
	if err := json.Unmarshal(project["nodes"], &nodes); err != nil {
		return nil, err
	}
	type candidate struct {
		index          int
		nodeID, taskID string
		metadata       map[string]json.RawMessage
	}
	candidates := make([]candidate, 0)
	ids := make([]string, 0)
	for i, node := range nodes {
		var nodeID, kind string
		_ = json.Unmarshal(node["id"], &nodeID)
		_ = json.Unmarshal(node["type"], &kind)
		if kind != "image" && kind != "panorama" {
			continue
		}
		var metadata map[string]json.RawMessage
		if json.Unmarshal(node["metadata"], &metadata) != nil {
			continue
		}
		var state struct {
			Content, StorageKey, ImageTaskID, Status string
			TaskPollError                            bool
		}
		if json.Unmarshal(node["metadata"], &state) != nil || state.Content != "" || state.StorageKey != "" || state.ImageTaskID == "" {
			continue
		}
		if state.Status != "loading" && state.Status != "success" && !(state.Status == "error" && state.TaskPollError) {
			continue
		}
		candidates = append(candidates, candidate{i, nodeID, state.ImageTaskID, metadata})
		ids = append(ids, state.ImageTaskID)
	}
	if len(candidates) == 0 {
		return raw, nil
	}
	tasks, err := repository.BatchUserCanvasImageTasks(userID, ids)
	if err != nil {
		return nil, err
	}
	changed := false
	for _, candidate := range candidates {
		for _, task := range tasks {
			if task.ID != candidate.taskID || task.UserID != userID || task.Source != "canvas" || task.SourceID != projectID || task.NodeID != candidate.nodeID || task.Status != "completed" {
				continue
			}
			id := strings.TrimPrefix(task.StorageKey, "server:")
			if id == "" || id == task.StorageKey || task.ImageURL != "/api/files/"+id+"/content" {
				continue
			}
			values := map[string]any{"content": task.ImageURL, "storageKey": task.StorageKey, "imageTaskResultId": task.ID, "status": "success", "mediaStatus": "ok", "progress": 100,
				"naturalWidth": task.Width, "naturalHeight": task.Height, "bytes": task.Bytes, "mimeType": task.MimeType}
			for key, value := range values {
				candidate.metadata[key], _ = json.Marshal(value)
			}
			for _, key := range []string{"taskPollError", "errorDetails", "mediaError", "stopState"} {
				delete(candidate.metadata, key)
			}
			nodes[candidate.index]["metadata"], err = json.Marshal(candidate.metadata)
			if err != nil {
				return nil, err
			}
			changed = true
			break
		}
	}
	if !changed {
		return raw, nil
	}
	project["nodes"], err = json.Marshal(nodes)
	if err != nil {
		return nil, err
	}
	return json.Marshal(project)
}
