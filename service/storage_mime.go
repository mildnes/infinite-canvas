package service

import (
	"errors"
	"mime"
	"strings"

	"github.com/gabriel-vasile/mimetype"
)

// The upload policy is independent from generated-media validation. No wildcard
// can admit a new executable or unsupported format through a client MIME header.
var uploadedMediaMIMEs = map[string]bool{
	"image/png": true, "image/jpeg": true, "image/webp": true, "image/gif": true,
	"image/avif": true, "image/bmp": true, "image/tiff": true,
	"video/mp4": true, "video/webm": true, "video/quicktime": true, "video/mpeg": true,
	"video/x-matroska": true, "video/ogg": true, "video/3gpp": true, "video/3gpp2": true,
	"audio/mpeg": true, "audio/mp4": true, "audio/webm": true, "audio/ogg": true,
	"audio/wav": true, "audio/flac": true, "audio/aac": true, "audio/aiff": true,
}

func NormalizeStorageMIME(value string) string {
	value, _, err := mime.ParseMediaType(strings.ToLower(strings.TrimSpace(value)))
	if err != nil {
		return ""
	}
	switch value {
	case "image/jpg", "image/pjpeg":
		return "image/jpeg"
	case "image/apng", "image/vnd.mozilla.apng":
		return "image/png"
	case "image/x-bmp", "image/x-ms-bmp":
		return "image/bmp"
	case "audio/x-wav", "audio/vnd.wave", "audio/wave":
		return "audio/wav"
	case "audio/mp3", "audio/x-mpeg":
		return "audio/mpeg"
	case "audio/x-m4a", "audio/x-mp4a":
		return "audio/mp4"
	case "audio/x-flac":
		return "audio/flac"
	case "audio/x-aiff":
		return "audio/aiff"
	case "video/x-m4v":
		return "video/mp4"
	case "video/3gp":
		return "video/3gpp"
	case "video/3g2":
		return "video/3gpp2"
	}
	return value
}

func IsSupportedUploadedMIME(value string) bool {
	return uploadedMediaMIMEs[NormalizeStorageMIME(value)]
}

func IsSupportedUploadedImageMIME(value string) bool {
	value = NormalizeStorageMIME(value)
	return strings.HasPrefix(value, "image/") && uploadedMediaMIMEs[value]
}

// NormalizeUploadedMIME checks bytes even when a multipart MIME was supplied.
// Audio and video share WebM/MP4/Ogg containers, whose media kind may need the
// declared MIME; the declaration never bypasses recognition of that container.
func NormalizeUploadedMIME(declared string, data []byte) (string, error) {
	declared = NormalizeStorageMIME(declared)
	detected := NormalizeStorageMIME(mimetype.Detect(data).String())
	if len(data) == 0 || !uploadedMediaMIMEs[detected] || (declared != "" && declared != "application/octet-stream" && !uploadedMediaMIMEs[declared]) {
		return "", errors.New("文件类型不受支持，请上传光栅图片或支持的视频、音频文件")
	}
	for _, format := range []string{"webm", "mp4", "ogg"} {
		if (declared == "audio/"+format || declared == "video/"+format) && (detected == "audio/"+format || detected == "video/"+format) {
			return declared, nil
		}
	}
	return detected, nil
}
