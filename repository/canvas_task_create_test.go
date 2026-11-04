package repository

import (
	"reflect"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestSaveCanvasTasksDoesNotOverwriteExistingRows(t *testing.T) {
	database := resultDB(t)
	tests := []struct {
		name string
		save func(string, string, string) (any, error)
		read func() (any, error)
	}{
		{
			name: "image",
			save: func(userID, status, prompt string) (any, error) {
				return SaveCanvasImageTask(model.CanvasImageTask{
					ID: "image", UserID: userID, Status: status, Prompt: prompt,
				})
			},
			read: func() (any, error) {
				var task model.CanvasImageTask
				err := database.First(&task, "id = ?", "image").Error
				return task, err
			},
		},
		{
			name: "audio",
			save: func(userID, status, prompt string) (any, error) {
				return SaveCanvasAudioTask(model.CanvasAudioTask{
					ID: "audio", UserID: userID, Status: status, Prompt: prompt,
				})
			},
			read: func() (any, error) {
				var task model.CanvasAudioTask
				err := database.First(&task, "id = ?", "audio").Error
				return task, err
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			original, err := test.save("owner", "completed", "original prompt")
			if err != nil {
				t.Fatal(err)
			}
			for _, userID := range []string{"owner", "other"} {
				duplicate, err := test.save(userID, "queued", "replacement prompt")
				if userID == "owner" {
					if err != nil || !reflect.DeepEqual(duplicate, original) {
						t.Fatalf("duplicate creation returned changed task: got=%+v want=%+v err=%v", duplicate, original, err)
					}
				} else if err == nil {
					t.Fatal("another user must not reuse an existing task ID")
				}
				stored, err := test.read()
				if err != nil || !reflect.DeepEqual(stored, original) {
					t.Fatalf("duplicate creation overwrote existing task for %s: got=%+v want=%+v err=%v", userID, stored, original, err)
				}
			}
		})
	}
}
