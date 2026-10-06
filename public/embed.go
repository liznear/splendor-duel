// Package public embeds the browser UI so desktop builds ship one binary.
package public

import "embed"

//go:embed all:api.js all:app.js all:index.html all:preview.js all:prototype-variants.css all:style.css all:assets all:cards
var Files embed.FS
