package service

import (
	"bytes"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"image/png"
	"io"

	"github.com/tigerowo/infinite-canvas/repository"
)

// PNGHasAlpha checks PNG metadata without decompressing full-size image pixels.
// DecodeConfig validates IHDR; the bounded chunk scan handles palette/RGB tRNS.
func PNGHasAlpha(data []byte) (bool, error) {
	if !bytes.HasPrefix(data, []byte("\x89PNG\r\n\x1a\n")) {
		return false, nil
	}
	if _, err := png.DecodeConfig(bytes.NewReader(data)); err != nil {
		return false, err
	}
	if data[25] == 4 || data[25] == 6 {
		return true, nil
	}
	for offset := 8; offset+12 <= len(data); {
		length := uint64(binary.BigEndian.Uint32(data[offset : offset+4]))
		end := uint64(offset) + 12 + length
		if end > uint64(len(data)) {
			return false, errors.New("PNG chunk truncated")
		}
		chunkType := string(data[offset+4 : offset+8])
		if chunkType == "IDAT" || chunkType == "IEND" {
			return false, nil
		}
		if chunkType == "tRNS" {
			checksum := binary.BigEndian.Uint32(data[int(end)-4 : int(end)])
			if crc32.ChecksumIEEE(data[offset+4:int(end)-4]) != checksum || length == 0 {
				return false, errors.New("invalid PNG transparency chunk")
			}
			return true, nil
		}
		offset = int(end)
	}
	return false, errors.New("PNG image data missing")
}

// Check the reliable local copy before cloud sync, including deduplicated objects
// whose provider has already changed to WebDAV/S3. No new upstream download.
func GeneratedMediaHasPNGAlpha(userID, objectID string) (bool, error) {
	object, err := repository.GetStorageObject(objectID)
	if err != nil {
		return false, err
	}
	if object.CreatedBy != userID || object.DeletedAt != "" {
		return false, errors.New("media owner mismatch")
	}
	media, err := generatedMediaFallback(object, "")
	if err != nil {
		return false, err
	}
	defer media.Stream.Close()
	data, err := io.ReadAll(io.LimitReader(media.Stream, workflowResultMediaLimit+1))
	if err != nil || int64(len(data)) > workflowResultMediaLimit {
		return false, errors.New("PNG media cannot be inspected")
	}
	return PNGHasAlpha(data)
}
