//go:build ignore

// One-off PWA icon generator: draws a flat two-gem icon (gold + pearl, the
// "duel") with pure stdlib, supersampled 2048 -> 512/192 via bilinear resample.
// Usage: go run scripts/gen_icons.go
package main

import (
	"fmt"
	"image"
	"image/png"
	"math"
	"os"
)

type pt struct{ x, y float64 }

type rgba struct{ r, g, b, a float64 } // 0..1 straight alpha

func clamp01(v float64) float64 { return math.Max(0, math.Min(1, v)) }

func lerp(c, d rgba, t float64) rgba {
	return rgba{c.r + (d.r-c.r)*t, c.g + (d.g-c.g)*t, c.b + (d.b-c.b)*t, c.a + (d.a-c.a)*t}
}

// over composites src over dst (straight alpha).
func over(src, dst rgba) rgba {
	a := src.a + dst.a*(1-src.a)
	if a == 0 {
		return rgba{}
	}
	mix := func(s, d float64) float64 { return (s*src.a + d*dst.a*(1-src.a)) / a }
	return rgba{mix(src.r, dst.r), mix(src.g, dst.g), mix(src.b, dst.b), a}
}

func inPoly(p pt, poly []pt) bool {
	in := false
	for i, j := 0, len(poly)-1; i < len(poly); i, j = i+1, i {
		if (poly[i].y > p.y) != (poly[j].y > p.y) &&
			p.x < (poly[j].x-poly[i].x)*(p.y-poly[i].y)/(poly[j].y-poly[i].y)+poly[i].x {
			in = !in
		}
	}
	return in
}

// sparklePoly builds a 4-point star centered at c with radius s.
func sparklePoly(c pt, s float64) []pt {
	w := s * 0.22
	return []pt{
		{c.x, c.y - s}, {c.x + w, c.y - w}, {c.x + s, c.y}, {c.x + w, c.y + w},
		{c.x, c.y + s}, {c.x - w, c.y + w}, {c.x - s, c.y}, {c.x - w, c.y - w},
	}
}

// gem is one token: rim ring + radial-gradient disc + glossy upper-left sheen.
type gem struct {
	c                 pt
	r                 float64
	rim               float64
	light, dark, rimC rgba
}

func (g gem) shade(p pt) rgba {
	dx, dy := p.x-g.c.x, p.y-g.c.y
	dist := math.Hypot(dx, dy)
	switch {
	case dist > g.r:
		return rgba{}
	case dist > g.r-g.rim:
		return g.rimC
	}
	t := clamp01((dist - g.r*0.45) / (g.r * 0.55))
	c := lerp(g.light, g.dark, t*t)
	if ang := math.Atan2(dy, dx); ang > -2.9 && ang < -1.9 && dist < g.r*0.97 {
		return over(rgba{1, 1, 1, 0.22}, c)
	}
	return c
}

// resample bilinear (alpha-aware).
func resample(src image.Image, w, h int) *image.NRGBA {
	dst := image.NewNRGBA(image.Rect(0, 0, w, h))
	sb := src.Bounds()
	sw, sh := sb.Dx(), sb.Dy()
	clamp := func(v, n int) int {
		if v < 0 {
			return 0
		}
		if v > n-2 {
			return n - 2
		}
		return v
	}
	corner := func(x, y int) [4]float64 {
		r, g, b, a := src.At(sb.Min.X+x, sb.Min.Y+y).RGBA()
		return [4]float64{float64(r >> 8), float64(g >> 8), float64(b >> 8), float64(a >> 8)}
	}
	for y := 0; y < h; y++ {
		fy := (float64(y)+0.5)/float64(h)*float64(sh) - 0.5
		y0 := clamp(int(fy), sh)
		wy := math.Max(fy-float64(y0), 0)
		for x := 0; x < w; x++ {
			fx := (float64(x)+0.5)/float64(w)*float64(sw) - 0.5
			x0 := clamp(int(fx), sw)
			wx := math.Max(fx-float64(x0), 0)
			c00, c10 := corner(x0, y0), corner(x0+1, y0)
			c01, c11 := corner(x0, y0+1), corner(x0+1, y0+1)
			for c := 0; c < 4; c++ {
				v := c00[c]*(1-wx)*(1-wy) + c10[c]*wx*(1-wy) + c01[c]*(1-wx)*wy + c11[c]*wx*wy
				dst.Pix[y*dst.Stride+4*x+c] = uint8(v + 0.5)
			}
		}
	}
	return dst
}

func hex(h uint32) rgba {
	return rgba{float64(h>>16&0xff) / 255, float64(h>>8&0xff) / 255, float64(h&0xff) / 255, 1}
}

func main() {
	const S = 2048
	img := image.NewNRGBA(image.Rect(0, 0, S, S))

	// 暖米色底 + 角落轻微暗角; 珍珠在后, 金币在前, 各带一处高光星。
	bg, bgDark := hex(0xece8dc), hex(0xdcd4c0)
	pearl := gem{
		c: pt{1200, 800}, r: 600, rim: 34,
		light: hex(0xfdfcf7), dark: hex(0xcfc9bd), rimC: hex(0xa89f8c),
	}
	gold := gem{
		c: pt{860, 1220}, r: 660, rim: 36,
		light: hex(0xf7dc6f), dark: hex(0xc68a12), rimC: hex(0x8a5f0a),
	}
	spGold := sparklePoly(pt{gold.c.x - 0.34*gold.r, gold.c.y - 0.42*gold.r}, 0.24*gold.r)
	spPearl := sparklePoly(pt{1000, 480}, 96)
	maxD := math.Hypot(S, S) / 2

	for y := 0; y < S; y++ {
		for x := 0; x < S; x++ {
			p := pt{float64(x) + 0.5, float64(y) + 0.5}
			t := clamp01(math.Hypot(p.x-S/2, p.y-S/2) / maxD)
			c := lerp(bg, bgDark, t*t)
			c = over(pearl.shade(p), c)
			if inPoly(p, spPearl) {
				c = over(rgba{1, 1, 1, 0.9}, c)
			}
			c = over(gold.shade(p), c)
			if inPoly(p, spGold) {
				c = over(rgba{1, 1, 1, 0.92}, c)
			}
			i := y*img.Stride + x*4
			img.Pix[i] = uint8(c.r*255 + 0.5)
			img.Pix[i+1] = uint8(c.g*255 + 0.5)
			img.Pix[i+2] = uint8(c.b*255 + 0.5)
			img.Pix[i+3] = uint8(c.a*255 + 0.5)
		}
	}

	for _, size := range []int{192, 512} {
		out, err := os.Create(fmt.Sprintf("public/assets/icon-%d.png", size))
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		if err := png.Encode(out, resample(img, size, size)); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		out.Close()
		fmt.Printf("wrote public/assets/icon-%d.png\n", size)
	}
}
