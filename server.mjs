
import express from "express"
import compression from "compression"
import path from "node:path"
import fs from "node:fs"

const app = express()
const PORT = process.env.PORT || 4443

// ✅ WebXR permission policy header
app.use((req, res, next) => {
  res.setHeader("Permissions-Policy", "xr-spatial-tracking=(self), fullscreen=(self)")
  res.setHeader("X-Content-Type-Options", "nosniff")
  next()
})

app.use(compression())
app.use(express.static(".", { extensions: ["html"] }))

app.listen(PORT, () => {
  console.log(`Local dev server: http://localhost:${PORT}`)
  console.log(`Header: Permissions-Policy: xr-spatial-tracking=(self), fullscreen=(self)`)
})
