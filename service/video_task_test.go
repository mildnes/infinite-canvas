package service

import (
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestFailedVideoTaskRefundUsesCapturedChargeOnlyOnce(t *testing.T) {
	task := model.VideoTask{ChannelID: "video-a", Model: "shared", Status: "failed", Credits: 86}
	if got := failedVideoTaskRefundAmount(task, true); got != 86 {
		t.Fatalf("first failed transition refund = %g, want original charge 86", got)
	}
	if got := failedVideoTaskRefundAmount(task, false); got != 0 {
		t.Fatalf("already finalized task must not refund twice: %g", got)
	}
	task.UserChannelID = "user-local"
	if got := failedVideoTaskRefundAmount(task, true); got != 0 {
		t.Fatalf("local channel must not refund server credits: %g", got)
	}
	task.UserChannelID = ""
	task.Status = "completed"
	if got := failedVideoTaskRefundAmount(task, true); got != 0 {
		t.Fatalf("completed task must not refund credits: %g", got)
	}
}
