package service

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"testing"
)

func TestPNGHasAlpha(t *testing.T) {
	transparent := image.NewNRGBA(image.Rect(0, 0, 2, 2))
	transparent.SetNRGBA(0, 0, color.NRGBA{R: 255, A: 255})
	checkerboard := image.NewRGBA(image.Rect(0, 0, 2, 2))
	for y := 0; y < 2; y++ {
		for x := 0; x < 2; x++ {
			value := uint8(242 + (x+y)%2*13)
			checkerboard.SetRGBA(x, y, color.RGBA{R: value, G: value, B: value, A: 255})
		}
	}
	palette := image.NewPaletted(image.Rect(0, 0, 2, 2), color.Palette{color.NRGBA{}, color.NRGBA{R: 255, A: 255}})
	palette.SetColorIndex(0, 0, 1)
	for _, test := range []struct {
		name  string
		input image.Image
		want  bool
	}{
		{"RGBA transparent", transparent, true},
		{"RGB fake checkerboard", checkerboard, false},
		{"indexed tRNS", palette, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			var encoded bytes.Buffer
			if err := png.Encode(&encoded, test.input); err != nil {
				t.Fatal(err)
			}
			alpha, err := PNGHasAlpha(encoded.Bytes())
			if err != nil || alpha != test.want {
				t.Fatalf("alpha=%v error=%v want=%v", alpha, err, test.want)
			}
		})
	}
	if alpha, err := PNGHasAlpha([]byte("not a PNG")); alpha || err != nil {
		t.Fatalf("non-PNG: %v %v", alpha, err)
	}
	if _, err := PNGHasAlpha([]byte("\x89PNG\r\n\x1a\n")); err == nil {
		t.Fatal("truncated PNG accepted")
	}
}
