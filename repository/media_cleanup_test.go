package repository

import "testing"

func TestServerObjectID(t *testing.T) {
	if id, ok := serverObjectID("server:object-1"); !ok || id != "object-1" {
		t.Fatalf("valid object id = %q, %v", id, ok)
	}
	for _, value := range []string{"image:object-1", "server:webdav:path", "server:../object", "server:"} {
		if _, ok := serverObjectID(value); ok {
			t.Fatalf("unsafe storage key accepted: %q", value)
		}
	}
}
