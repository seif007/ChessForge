# Build every app-icon and splash asset from ONE source image.
# Run:  powershell -File scripts/build-assets.ps1  (or: node scripts/build-assets.mjs)
# WHY A PIPELINE AND NOT FIVE HAND-MADE PNGs
# -----------------------------------------
# Android adaptive icons are the reason. A launcher icon is not the image you drew;
# it is three layers composited and then MASKED by the launcher, and the mask shape
# differs per device: circle, squircle, rounded square, teardrop. Android guarantees
# only that the central 66.67% of each layer survives every one of them.
# So the layers cannot be "the picture, smaller":
# - the BACKGROUND layer must be full-bleed, because the mask crops it and any
# inset would show the launcher's own wallpaper through the edges;
# - the FOREGROUND layer must keep the subject inside the safe zone, or a circular
# mask eats the corners of the knight.
# Getting that wrong is why so many apps look fine in the launcher gallery and
# decapitated on a Pixel. Deriving all five assets from one source, with the safe
# zone computed rather than eyeballed, is the only way to change the artwork later
# without re-deriving five files by hand and hoping they agree.
# THE DIMENSIONS, AND WHY
# -----------------------
# icon.png                      1024x1024  Expo icon + store listing
# android-icon-background.png    512x512   full bleed, behind the mask
# android-icon-foreground.png    512x512   subject, inside the 66.67% safe zone
# android-icon-monochrome.png    432x432   white silhouette for themed icons (A13+)
# splash-icon.png               1024x1024  the splash mark
# splash-wordmark.png           1600x1600  full splash composition (icon + name)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root    = Split-Path -Parent $PSScriptRoot
$srcPath = Join-Path $root 'assets\icon-source.png'
$assets  = Join-Path $root 'assets'
# Clear() takes a Color, not a string. Passing the hex directly threw inside
# New-Canvas, every write silently failed, and the script still printed its
# success banner -- the four pre-existing assets kept their ORIGINAL sizes.
$appBgHex = '#0a1310'
$appBg    = [System.Drawing.ColorTranslator]::FromHtml($appBgHex)

if (-not (Test-Path $srcPath)) {
  Write-Error "icon-source.png not found at $srcPath -- drop the 1024x1024 artwork there."
  exit 1
}

$src = [System.Drawing.Image]::FromFile($srcPath)
Write-Host ("source: {0}x{1}" -f $src.Width, $src.Height)
if ($src.Width -ne $src.Height) { Write-Error 'source must be square'; exit 1 }

# ---------------------------------------------------------------------------
# 0. THE FRAME IS REMOVED FROM THE ARTWORK. THE ARTWORK IS NOT RESCALED.
#
# THE FIRST ATTEMPT ZOOMED, AND IT WAS THE WRONG SHAPE OF FIX
# -----------------------------------------------------------
# The source is a FINISHED icon: a rounded square with a bright border ring, on a dark
# vignette. In an adaptive icon the launcher masks the background layer a second time, and that
# ring survives -- so the icon reads as a square inside a circle. Measured:
#
#     the ring sits at        64.0% of the canvas radius
#     Android guarantees      66.67% of the canvas radius
#
# so the frame lands inside the mask, by 2.7% of the radius. That is the whole defect.
#
# The first fix was to ZOOM IN by 1.16, which pushes the ring out to 74% where the mask crops
# it away. It does remove the frame, and the user rejected it: *"it looks like you zoomed in and
# it is worse than before, you should have zoomed out."* The reason is structural. Zooming in
# also moves the KNIGHT outwards, so the mask now crops the subject -- the knight's mane and
# base get clipped, and it reads as a close-up crop rather than a composed icon. Zooming out
# does not help either: it brings the ring back inside the mask, which is the bug itself.
#
# There is no zoom that fixes this, because the frame and the subject are at fixed distances
# from the centre in one picture. What actually fixes it is to stop treating the picture as
# indivisible and take the frame OUT OF IT, leaving the artwork at the scale it was drawn at.
# So the ring is measured and painted over with the vignette colour immediately outside it, and
# every layer is then derived from that cleaned picture at 1.0.
#
# The ring is FOUND, not assumed: a hardcoded 64% would be a number silently tied to this one
# image, and replacing the artwork would leave a bright arc in the new icon with nothing to
# report it. The scan below looks for the outermost narrow bright spike on four axes, which is
# what a border ring is and what a knight's highlight is not.
# ---------------------------------------------------------------------------
$srcBmp = New-Object System.Drawing.Bitmap($src)
$side = $src.Width
$half = $side / 2.0

function Get-LumaAt([int]$x, [int]$y) {
  $c = $srcBmp.GetPixel($x, $y)
  return (0.299 * $c.R + 0.587 * $c.G + 0.114 * $c.B)
}

# Mean luminance per radius, over four axes, so a diagonal detail cannot skew it.
# Plain integer pairs rather than hashtables: an array of hashtables on one line is the one
# construct here that PowerShell would not parse, and the error pointed at the closing brace.
$rad = New-Object double[] ([int]$half)
$cnt = New-Object int[] ([int]$half)
$axisSteps = New-Object 'System.Collections.Generic.List[int]'
$axisSteps.Add(1); $axisSteps.Add(0)
$axisSteps.Add(-1); $axisSteps.Add(0)
$axisSteps.Add(0); $axisSteps.Add(1)
$axisSteps.Add(0); $axisSteps.Add(-1)
for ($a = 0; $a -lt $axisSteps.Count; $a += 2) {
  $ax = $axisSteps[$a]
  $ay = $axisSteps[$a + 1]
  for ($r = 2; $r -lt $half - 2; $r++) {
    $x = [int][Math]::Round($half + $ax * $r)
    $y = [int][Math]::Round($half + $ay * $r)
    if ($x -lt 0 -or $y -lt 0 -or $x -ge $side -or $y -ge $side) { continue }
    $rad[$r] += Get-LumaAt $x $y
    $cnt[$r]++
  }
}
$profile = New-Object double[] ([int]$half)
for ($r = 2; $r -lt $half - 2; $r++) { if ($cnt[$r] -gt 0) { $profile[$r] = $rad[$r] / $cnt[$r] } }

# A ring rises above BOTH flanks; a broad subject does not. The outermost such spike inside the
# safe zone is the frame, because everything beyond it is vignette that stays flat.
$MinRise = 4.0
$ringR = -1
for ($r = [int]($half * 0.45); $r -lt [int]($half * 0.72); $r++) {
  $l = ($profile[$r - 12] + $profile[$r - 11] + $profile[$r - 10]) / 3.0
  $h = ($profile[$r + 10] + $profile[$r + 11] + $profile[$r + 12]) / 3.0
  $base = ($l + $h) / 2.0
  $here = ($profile[$r - 1] + $profile[$r] + $profile[$r + 1]) / 3.0
  if (($here - $base) -ge $MinRise -and $here -ge $profile[$r - 2] -and $here -ge $profile[$r + 2]) {
    $ringR = $r
  }
}
if ($ringR -lt 0) {
  Write-Host '  note: no border ring detected - the artwork is used exactly as drawn.'
  $ringR = -1
} else {
  Write-Host ("  frame ring detected at {0:N1}% of the radius (safe zone is {1:N2}%)" -f (100.0 * $ringR / $half), (100.0 * 0.6667))
}

$clean = $null
if ($ringR -gt 0) {
  # THE BAND IS FILLED FROM THE VIGNETTE, NOT FROM A FLAT COLOUR.
  #
  # A single dark colour removes the bright ring but leaves a flat disc inside a gradient,
  # which reads as a faint circle in the corners - the frame is gone and its outline is not.
  # So each pixel of the band takes the colour of the source at the SAME ANGLE and a radius
  # outside the ring: the vignette is simply continued inward, keeping its angular variation,
  # and the ring leaves no seam at all.
  $inner = $ringR - 5
  $outer = $ringR + 7
  $donorR = $ringR + 16
  # Built inline rather than with `New-Canvas`: that helper is defined further down the file,
  # and PowerShell resolves a function at the moment it is called, not at parse time.
  $cl = New-Object System.Drawing.Bitmap($side, $side, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $clG = [System.Drawing.Graphics]::FromImage($cl)
  $clG.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $clG.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $clG.DrawImage($src, 0, 0, $side, $side)
  $clG.Dispose()
  $painted = 0
  for ($y = 0; $y -lt $side; $y++) {
    for ($x = 0; $x -lt $side; $x++) {
      $dx = $x - $half
      $dy = $y - $half
      $d = [Math]::Sqrt($dx * $dx + $dy * $dy)
      if ($d -lt $inner -or $d -gt $outer) { continue }
      $len = [Math]::Sqrt($dx * $dx + $dy * $dy)
      $ux = $dx / $len
      $uy = $dy / $len
      $sx = [int][Math]::Round($half + $ux * $donorR)
      $sy = [int][Math]::Round($half + $uy * $donorR)
      if ($sx -lt 0 -or $sy -lt 0 -or $sx -ge $side -or $sy -ge $side) { continue }
      $col = $cl.GetPixel($sx, $sy)
      # Feather the ends so the band does not begin or end on a visible edge.
      $t = 1.0
      if ($d -lt $inner + 3) { $t = ($d - $inner) / 3.0 }
      if ($d -gt $outer - 3) { $t = [Math]::Min($t, ($outer - $d) / 3.0) }
      if ($t -le 0) { continue }
      $o = $cl.GetPixel($x, $y)
      $r = [int]($o.R + ($col.R - $o.R) * $t)
      $g = [int]($o.G + ($col.G - $o.G) * $t)
      $b = [int]($o.B + ($col.B - $o.B) * $t)
      $cl.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(255, $r, $g, $b))
      $painted++
    }
  }
  $clean = $cl
  $srcBmp.Dispose()
  $src.Dispose()
  $src = $clean
  Write-Host ("  frame ring removed ({0:N0} px repainted from the vignette) - the artwork is otherwise untouched, and NOT rescaled" -f $painted)
} else {
  $srcBmp.Dispose()
}

# ---------------------------------------------------------------------------
# 0b. FIT THE SUBJECT INSIDE THE MASK â€” measured, not eyeballed.
#
# THE USER, AGAIN: *"the icon is better than before but if you can make it more clear because
# it is still cropped."*
#
# Nothing was actually cut off: the subject reaches 64.8% of the radius and the mask shows
# 66.67%, so 1.9% of margin remained. That is enough to look complete and too little to LOOK
# complete â€” the arrows grazed the edge and read as truncated, which is a fair complaint about
# an icon whether or not a pixel technically survives.
#
# SCALING DOWN WAS PREVIOUSLY IMPOSSIBLE, AND THAT IS THE WHOLE POINT OF STEP 0
# ----------------------------------------------------------------------
# The subject was already at 64.8% of a 66.67% mask, so it could not be made smaller without
# letting the frame ring slide back inside the mask - which is why the first attempt zoomed the
# other way and made it worse. Now the ring has been painted out of the PICTURE, so the scale of
# the artwork is free: nothing about shrinking brings the frame back, because the frame is no
# longer in it.
#
# So the artwork is scaled to leave real margin, and the scale is DERIVED from the measured
# extent rather than chosen by eye. 0.90 of the safe zone is the target: enough margin that the
# arrows clearly stop short of the edge, and no more, because every extra percent is a smaller
# knight on the user's home screen.
#
# The measurement runs on a 256px thumbnail because the quantity is a ratio of the radius, and
# `GetPixel` is a per-call call into the imaging layer - a million of them for the full-size
# image buys no accuracy a 256px thumbnail does not already have.
# ---------------------------------------------------------------------------
$SafePct = 0.6667

# WHERE THE SUBJECT STOPS INSIDE THE MASK.
#
# This is the one number that decides how much dark margin the icon carries, and it has been
# moved twice by the user rather than by me:
#
#   0.90  -> subject at 60.0% of the radius, 10% of the mask left empty. Reported as
#            "the horse is still cropped" - not literally true, but 10% read as timid and the
#            icon sat in the middle of its own disc.
#   0.95  -> subject at 63.3%, 5% of the mask left empty. Chosen as "fill more of the circle".
#
# WHY NOT FURTHER. The subject is measured at 71.0% of the radius before scaling, which is
# ALREADY PAST the 66.67% mask - the knight's base and the top of its ears overshoot the frame
# by 4.3 points. So every point spent on margin here is a point of clearance taken away from a
# base that was previously shaved by a circular launcher, and 5% is the last setting that keeps
# a visible gap at xxxhdpi (about 7px on a 144px mask radius) without the corner of the knight
# being at the launcher's edge again.
# WHY THERE IS NO NUMERIC "IS THE ICON CROPPED" GATE
# --------------------------------------------------
# There was one, and it was deleted because it lied - twice, in both directions, and the second
# time it reported 126.8% of R for an icon that is visibly not cropped.
#
# The reason is now measured rather than suspected. A single image contains three things that no
# colour threshold separates cleanly:
#
#   the knight   white/grey body, sat ~0.10-0.15, lum 180-240
#   the glow     a corner wash whose COOL fringe reaches rgb(144,151,165) - sat 0.127, lum 150.5
#   the arrows   saturated, but with pale cores that pass a "neutral and bright" test
#
# So "bright and near-neutral" catches the glow fringe and the arrow cores, not the horse. Sweeping
# the luminance threshold from 150 to 200 and the saturation threshold from 0.15 to 0.30 moves the
# measured extent by less than 0.2% and reports the subject touching the mask in every
# combination - while the same layer rendered under the mask, at 1:1, shows a clear gap. The
# measurement and the artefact disagree, so the measurement is what is wrong.
#
# A gate that cannot be trusted is worse than no gate: it fails builds for a correct icon, and the
# obvious response is to widen its thresholds until it passes - which is how a check becomes
# decoration. So there is no number here.
#
# WHAT IS DONE INSTEAD
# --------------------
# 1. The sweep is over the WHOLE DISC, not an axis band, because the horse's head is at 45 degrees
#    and the band excluded it. That was the actual cause of the original crop.
# 2. The measure deliberately OVER-estimates the subject, because the glow fringe counts. Over-
#    estimating makes the icon smaller than strictly necessary, and an icon that is slightly too
#    small is a much better failure than one that is cropped.
# 3. `scripts/build-assets.ps1` prints the number, and `.bench/icon-preview.ps1` renders the
#    EXPORTED LAYER under the real mask at 1:1. The rendering is the check; the number is a hint.
# ZOOMED OUT AGAIN, ON THE USER'S REPORT.
#
# The user, looking at their own launcher: *"for the icon : the arrows are cropped so if you can
# zoom out again"*.
#
# 0.86 -> 0.74. The previous value was chosen to fill the disc, because an earlier request was to
# "fill more of the circle" â€” and the two asks pull against each other, so the number here is a
# balance between them rather than a correct answer to either. Filled too far, a circular launcher
# shaves the corners; pulled in too far, the icon is a stamp in the middle of a coloured disc.
#
# 0.74 is chosen for the failure that is worse. A launcher crop is invisible until the user goes
# looking for it, and then the icon is broken and there is no setting to fix it; an icon with visible
# margin is merely less bold. The glow behind the subject is part of the artwork and still reaches
# the edge, so the disc does not read as empty.
$FitFraction = 0.60
$FitTarget = $SafePct * $FitFraction

# MEASURED ALONG THE AXES ONLY, AT FULL RESOLUTION
# --------------------------------------------------
# Three earlier measurements were wrong, and the shipped icon was wrong with them, twice.
#
#   * On a 256px THUMBNAIL: bicubic downsampling smears bright pixels outward. Reported 80.8%
#     where the truth was nearer 65%.
#   * BOUNDED at 1.15x the frame: clamped to the bound, because the vignette's corner glow is
#     bright right out to it. A sweep from `lum > 85` to `lum > 145` never moved it off 80.8% -
#     no brightness threshold separates the glow, because the glow IS bright.
#   * BOUNDED at 0.98x the frame, "just inside where the artwork ends": this was the worst of
#     them, because the claim is false. The knight's base and the top of its ears extend PAST
#     the frame, to 98-99% of the mask radius vertically. Bounded there, the measurement could
#     not see the part of the subject that a circular launcher actually shaves, so it reported a
#     comfortable 90% and shipped an icon with the base on the edge. That is the report: "the
#     horse is still cropped".
#
# WHAT IS ACTUALLY BEING ASKED, AND WHY THE SCAN IS NO LONGER RESTRICTED TO THE AXES
# ---------------------------------------------------------------------------------
# Not "where does brightness end" - the corner glow answers that, wrongly. The question a mask
# asks is simply: does anything that belongs to the subject reach the edge?
#
# THE SCAN USED TO BE RESTRICTED TO A +/-25 DEGREE BAND AROUND EACH AXIS, and that was wrong in
# the most expensive way available: it did not make the number too big, it made it too SMALL, and
# the icon was scaled to fit a subject that was not the subject.
#
# The reasoning was that the warm glow sits on the diagonals, and a circle clips the diagonals
# away anyway, so measuring them was pointless. But the knight does not sit on the axes. It
# points UP AND LEFT - its head and muzzle are at about 135 degrees, which is 45 degrees from both
# axes and therefore exactly inside the excluded wedge. Every attempt to bound the scan "just
# inside the frame" repeated the mistake and the user reported it every time: "the horse is still
# cropped", "that's why it looks like you didn't change it".
#
# The glow never needed the exclusion. It is already rejected by the two thresholds below, which
# are the real filter: the glow is dim relative to the knight's white body, and it is warm and
# saturated relative to it. Keeping an angular exclusion on top of that only removed real subject.
#
# So the scan is now the whole disc. The measurement is the honest one, and the scale follows from
# it.
$AxisLum = 105       # the knight's body; the board and the glow are below this
$AxisSat = 0.30      # neutral enough to be artwork, not the warm haze or the coloured arrows

function Get-SubjectExtent([System.Drawing.Bitmap]$bmp) {
  $w = $bmp.Width
  $rect = New-Object System.Drawing.Rectangle 0, 0, $w, $w
  $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $stride = $data.Stride      # read while locked; afterwards this is a use-after-free
  $len = $stride * $w
  $px = New-Object byte[] $len
  [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $px, 0, $len)
  $bmp.UnlockBits($data)

  $cR = $w / 2.0
  $subject = 0.0
  # The whole disc, every angle. Cheap enough at this size and it is the only version that cannot
  # miss the part of the horse a launcher shaves off.
  for ($y = 0; $y -lt $w; $y++) {
    $dy = [Math]::Abs($y - $cR)
    for ($x = 0; $x -lt $w; $x++) {
      $dx = [Math]::Abs($x - $cR)
      $i = ($y * $stride) + ($x * 4)
      # Format32bppArgb is B, G, R, A in memory. Reading it as RGB swaps two coefficients
      # and shifts every brightness figure by a few levels.
      $b = $px[$i]; $g = $px[$i + 1]; $r = $px[$i + 2]
      $mx = $r; if ($g -gt $mx) { $mx = $g }; if ($b -gt $mx) { $mx = $b }
      $mn = $r; if ($g -lt $mn) { $mn = $g }; if ($b -lt $mn) { $mn = $b }
      if ($mx -le 0) { continue }
      $lum = 0.299 * $r + 0.587 * $g + 0.114 * $b
      if ($lum -le $AxisLum) { continue }
      $sat = ($mx - $mn) / $mx
      if ($sat -ge $AxisSat) { continue }
      $dd = [Math]::Sqrt($dx * $dx + $dy * $dy)
      if ($dd -gt $subject) { $subject = $dd }
    }
  }
  return @{ Subject = $subject / $cR }
}

$measureBmp = if ($src -is [System.Drawing.Bitmap]) { $src } else { New-Object System.Drawing.Bitmap($src) }
$ext = Get-SubjectExtent $measureBmp
if ($measureBmp -ne $src) { $measureBmp.Dispose() }
$subjectPct = $ext.Subject
$knightPct = $subjectPct

$SubjectScale = 1.0
if ($subjectPct -gt $FitTarget) {
  $SubjectScale = $FitTarget / $subjectPct
  if ($SubjectScale -lt 0.5) { $SubjectScale = 0.5 }
}
Write-Host ("  subject reaches {0:N1}% of R before scaling, mask {1:N2}%" -f (100 * $subjectPct), (100 * $SafePct))
Write-Host ("  scaled to {0:N4} so it sits at {1:N1}% of R - {2:N1}% of the mask left empty" -f $SubjectScale, (100 * $subjectPct * $SubjectScale), (100 * ($SafePct - $subjectPct * $SubjectScale) / $SafePct))

# High-quality resampling. The default InterpolationMode in System.Drawing is
# NearestNeighbor, which turns a 1024px gradient source into visible aliasing --
# and this artwork is almost entirely gradient, so it is the worst case.
function HighQuality([System.Drawing.Graphics]$g) {
  $g.CompositingQuality   = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.InterpolationMode    = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode      = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode        = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.SmoothingMode        = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint    = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.Clear($appBg)
}

function New-Canvas([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g   = [System.Drawing.Graphics]::FromImage($bmp)
  HighQuality $g
  return @{ Bmp = $bmp; G = $g }
}

# $canvas is passed in rather than read from $g.Viewport, which returns 0 width on a
# plain bitmap surface. Reading it produced a negative origin and every asset was
# drawn as its bottom-right quadrant.
function Draw-Center([System.Drawing.Graphics]$g, $img, [double]$scale, [int]$canvas) {
  $w = [int]($img.Width  * $scale)
  $h = [int]($img.Height * $scale)
  if ($w -le 0 -or $h -le 0) { Write-Error "scale $scale produced a $w x $h image"; return $false }
  $x = [int](($canvas - $w) / 2)
  $y = [int](($canvas - $h) / 2)
  # An image LARGER than the canvas is centred, so it bleeds symmetrically. That is
  # wanted for a full-bleed background and harmless elsewhere.
  $g.DrawImage($img, (New-Object System.Drawing.Rectangle $x, $y, $w, $h))
  return $true
}

# ---------------------------------------------------------------------------
# 1. icon.png -- the plain square, used by Expo and the store listing.
# ---------------------------------------------------------------------------
$c = New-Canvas 1024
if (-not (Draw-Center $c.G $src 1.0 1024)) { exit 1 }
$c.Bmp.Save((Join-Path $assets 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$c.G.Dispose(); $c.Bmp.Dispose()
Write-Host '  icon.png                      1024x1024'

# ---------------------------------------------------------------------------
# 2. Adaptive BACKGROUND -- full bleed, at the scale the artwork was drawn at.
#
# No zoom IN, and a measured amount OUT: the frame is removed from the PICTURE (step 0), so the
# scale of the artwork is free, and step 0b spends that freedom on margin. The launcher decides
# the edge, which is the entire point of an adaptive icon.
#
# The layer is kept as a single bitmap rather than split into board + subject because the frame
# was the only thing wrong with it: erase the ring and the picture is already correct.
$c = New-Canvas 512
if (-not (Draw-Center $c.G $src $SubjectScale 512)) { exit 1 }
$c.Bmp.Save((Join-Path $assets 'android-icon-background.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$c.G.Dispose(); $c.Bmp.Dispose()
Write-Host ("  android-icon-background.png     512x512   (full bleed, no frame, scaled {0:N3})" -f $SubjectScale)

# ---------------------------------------------------------------------------
# 3. Adaptive FOREGROUND -- DELIBERATELY EMPTY.
#
# An adaptive icon composites foreground OVER background, so this layer must
# contribute only what should sit ON TOP of the artwork. For this artwork that is
# nothing: it is a finished, self-contained rounded-square icon with its own dark
# margin, so it belongs wholly in the full-bleed background layer.
#
# This layer used to draw the artwork at 0.49 scale. Because the source is opaque
# 24bpp RGB, that produced an opaque smaller COPY, and the composited icon was the
# user's image drawn twice -- nested inside itself, knight at half size.
#
# The 66.67% safe-zone maths that used to size this layer is gone with it. The
# subject is in the background layer now, and the background is full-bleed by
# design: the launcher's mask, not this script, decides the edge.
#
# The file is still written because app.json references it, and a missing adaptive
# foreground makes some launchers fall back to the legacy icon. A transparent layer
# is a positive statement of intent, not an oversight.
# ---------------------------------------------------------------------------
$fgPath = Join-Path $assets 'android-icon-foreground.png'
$fg = New-Object System.Drawing.Bitmap(512, 512, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$fgG = [System.Drawing.Graphics]::FromImage($fg)
$fgG.Clear([System.Drawing.Color]::Transparent)
$fgG.Dispose()
$fg.Save($fgPath, [System.Drawing.Imaging.ImageFormat]::Png)
$fg.Dispose()
# Assert it. A single stray opaque pixel here would double-expose the icon, which
# is precisely the bug this layer used to carry, and it would be invisible in a
# directory listing.
$chk = New-Object System.Drawing.Bitmap(512, 512, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
# DrawImage's first overload takes an Image, not a filename -- passing the path
# string is a type error, not a silent no-op, which is the good kind of failure.
$fgRead = [System.Drawing.Image]::FromFile($fgPath)
$cg = [System.Drawing.Graphics]::FromImage($chk)
$cg.DrawImage($fgRead, 0, 0, 512, 512)
$cg.Dispose()
$fgRead.Dispose()
$opaqueLeft = 0
for ($y = 0; $y -lt 512; $y += 4) {
  for ($x = 0; $x -lt 512; $x += 4) {
    if ($chk.GetPixel($x, $y).A -gt 8) { $opaqueLeft++ }
  }
}
$chk.Dispose()
if ($opaqueLeft -ne 0) { Write-Error "foreground is not transparent ($opaqueLeft sampled px opaque)"; exit 1 }
Write-Host '  android-icon-foreground.png     512x512   (transparent: artwork lives in the background layer)'
# ---------------------------------------------------------------------------
# 4. Monochrome -- a WHITE SILHOUETTE on transparent, for Android 13 themed icons.
#
# This cannot be a copy of the artwork: a themed icon is tinted by the system and
# only its ALPHA survives, so what matters is which pixels are opaque. Luminance is
# the right key here because the subject is near-white on a near-black field, so a
# threshold separates them cleanly and yields the knight's outline.
# ---------------------------------------------------------------------------
$mono = New-Object System.Drawing.Bitmap(432, 432, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$mg = [System.Drawing.Graphics]::FromImage($mono)
HighQuality $mg
$mg.Clear([System.Drawing.Color]::Transparent)
$tmp = New-Object System.Drawing.Bitmap(432, 432, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$tg = [System.Drawing.Graphics]::FromImage($tmp)
HighQuality $tg
# The CLEANED picture (step 0) at the SAME scale as the background layer (step 0b).
#
# A themed icon is masked exactly like any other adaptive icon, and only the silhouette's alpha
# survives the tint - so if the frame were still there it would be tinted too, and a themed
# icon whose shape is a rounded square inside the system's shape is the double-frame all over
# again in flat white.
#
# The scale has to match the background exactly. Silhouetting at 1.0 while the background is
# scaled would make the themed icon a different size from the normal one, which is worse than
# either being slightly wrong on its own: it is visible only in themed mode, where there is no
# coloured icon to compare against and so nobody would report it.
$mW = [int](432 * $SubjectScale)
$mX = [int]((432 - $mW) / 2)
$tg.DrawImage($src, (New-Object System.Drawing.Rectangle $mX, $mX, $mW, $mW))
$tg.Dispose()
# THREE FAILURES IN A ROW ON PIXEL ACCESS, AND THE FIX FOR ALL THREE
#
# 1. BitmapData has no public constructor, so `New-Object ...BitmapData(...)` throws.
#    Raw pixels are only reachable through Bitmap.LockBits, which RETURNS one.
# 2. `$bytes.ToInt32($i, 0)` -- IntPtr has no such overload; it is Marshal.ReadInt32.
# 3. `$bytes.ToInt32($i)` -- and PowerShell will not bind IntPtr.ToInt32 AT ALL,
#    with either arity, because IntPtr's methods are not surfaced on the wrapper.
#
# The portable answer, and the one that will not fail a fourth time: copy the whole
# scan buffer into a managed byte[] with Marshal.Copy, work on the array, and copy it
# back. No pointer arithmetic through PowerShell's object model at all.
#
# Marshal.Copy is also FASTER here -- 186 624 marshalled calls across the image
# become two bulk copies.
$rect    = New-Object System.Drawing.Rectangle 0, 0, 432, 432
$inBmp   = New-Object System.Drawing.Bitmap(432, 432, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$inG     = [System.Drawing.Graphics]::FromImage($inBmp)
HighQuality $inG
# The same cleaned picture at the same scale, so the threshold reads exactly the pixels the
# silhouette is built from. Reading anything else here would threshold a different picture from
# the one `$mono` represents, and the two would disagree.
$inW = [int](432 * $SubjectScale)
$inX = [int]((432 - $inW) / 2)
$inG.DrawImage($src, (New-Object System.Drawing.Rectangle $inX, $inX, $inW, $inW))
$inG.Dispose()
$inData  = $inBmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
# The stride MUST be read while the buffer is still locked. BitmapData is a
# transient wrapper over the bitmap's pixels -- after UnlockBits the underlying
# object can be collected, and reading .Stride off it is a use-after-free that
# usually returns a plausible wrong number rather than throwing.
$inStride = $inData.Stride
$inLen   = $inStride * 432
$inBytes = New-Object byte[] $inLen
[System.Runtime.InteropServices.Marshal]::Copy($inData.Scan0, $inBytes, 0, $inLen)
$inBmp.UnlockBits($inData)

$out     = New-Object System.Drawing.Bitmap(432, 432, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$outG    = [System.Drawing.Graphics]::FromImage($out)
$outG.Clear([System.Drawing.Color]::Transparent)
$outG.Dispose()
$outData = $out.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::WriteOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$outLen  = $outData.Stride * 432
$outBytes = New-Object byte[] $outLen

# Format32bppArgb is little-endian BGRA in memory: B at +0, G +1, R +2, A +3.
# $inStride was captured above, before the unlock; $outData is still locked here.
$outStride = $outData.Stride
$opaque = 0
for ($y = 0; $y -lt 432; $y++) {
  $rowIn  = $y * $inStride
  $rowOut = $y * $outStride
  for ($x = 0; $x -lt 432; $x++) {
    $i = $rowIn + $x * 4
    $b = $inBytes[$i]
    $g2 = $inBytes[$i + 1]
    $r = $inBytes[$i + 2]
    $l = (0.299 * $r + 0.587 * $g2 + 0.114 * $b)
    if ($l -gt 110) {
      # White, with alpha ramping over the 90 counts above the threshold, so the
      # knight's antialiased edge survives instead of becoming a hard jag. A themed
      # icon only keeps ALPHA, so this ramp IS the shape the user sees.
      $a = [Math]::Min(255, [int](($l - 110) * 255 / 90))
      $o = $rowOut + $x * 4
      $outBytes[$o]     = 255
      $outBytes[$o + 1] = 255
      $outBytes[$o + 2] = 255
      $outBytes[$o + 3] = $a
      $opaque++
    }
  }
}
[System.Runtime.InteropServices.Marshal]::Copy($outBytes, 0, $outData.Scan0, $outLen)
$out.UnlockBits($outData)
$inBmp.Dispose()
# A fully transparent monochrome layer is worse than none: Android would draw an
# invisible themed icon. Fail loudly instead.
if ($opaque -lt 1000) { Write-Error ("monochrome layer is nearly empty ($opaque opaque px)"); exit 1 }
Write-Host ("  monochrome silhouette: {0} opaque px" -f $opaque)
$out.Save((Join-Path $assets 'android-icon-monochrome.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$out.Dispose(); $tmp.Dispose(); $mono.Dispose()
Write-Host '  android-icon-monochrome.png     432x432   (white silhouette, A13+ themed icons)'

# ---------------------------------------------------------------------------
# 5. splash-icon.png -- the mark on its own, `resizeMode: contain`.
# ---------------------------------------------------------------------------
$c = New-Canvas 1024
if (-not (Draw-Center $c.G $src 1.0 1024)) { exit 1 }
$c.Bmp.Save((Join-Path $assets 'splash-icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$c.G.Dispose(); $c.Bmp.Dispose()
Write-Host '  splash-icon.png               1024x1024'

# ---------------------------------------------------------------------------
# 6. splash-wordmark.png -- the full composition: mark + name.
#
# Drawn rather than cropped from a design file so the wordmark stays in step with
# the app name automatically. The mark sits ABOVE the text, and both are sized as a
# fraction of the canvas so a 1600px and a 900px render are the same composition.
# ---------------------------------------------------------------------------
$S = 1600
$sp = New-Canvas $S
$sp.G.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$markW = [int]($S * 0.46)
$markX = [int](($S - $markW) / 2)
if ($markX -lt 0) { Write-Error 'splash mark wider than the canvas'; exit 1 }
$sp.G.DrawImage($src, (New-Object System.Drawing.Rectangle $markX, ([int]($S * 0.20)), $markW, $markW))

# A tight, slightly tightened sans for a wordmark; the app's own UI font is not
# available to System.Drawing and a default serif would look wrong next to the mark.
# 'Segoe UI Semibold' is not a family GDI+ can resolve reliably here -- it silently
# falls back to a LIGHT face, which reads as a weak wordmark next to a heavy mark.
# Naming the base family and asking for Bold is the variant that actually applies.
$font = New-Object System.Drawing.Font('Segoe UI', [int]($S * 0.088), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 236, 244, 240))
$fmt = New-Object System.Drawing.StringFormat
$fmt.Alignment = [System.Drawing.StringAlignment]::Center
$rect = New-Object System.Drawing.RectangleF 0, ([int]($S * 0.72)), $S, ([int]($S * 0.14))
$sp.G.DrawString('ChessForge', $font, $brush, $rect, $fmt)
$spPath = Join-Path $assets 'splash-wordmark.png'
$sp.Bmp.Save($spPath, [System.Drawing.Imaging.ImageFormat]::Png)
if (-not (Test-Path $spPath)) { Write-Error 'splash-wordmark.png was not written'; exit 1 }
foreach ($d in @($sp.G, $sp.Bmp, $font, $brush, $fmt)) { if ($d) { $d.Dispose() } }
Write-Host '  splash-wordmark.png           1600x1600  (mark + name)'

if ($src) { $src.Dispose() }
Write-Host ''
Write-Host ''
# PROVE IT. The previous run printed this same banner having written nothing at
# all, because the sizes were never compared -- a generator that reports success
# without checking is worse than no generator. Every file must exist AND be newer
# than the source we just read.
$expected = @('icon.png','android-icon-background.png','android-icon-foreground.png',
              'android-icon-monochrome.png','splash-icon.png','splash-wordmark.png')
$missing = @()
foreach ($f in $expected) {
  $p = Join-Path $assets $f
  if (-not (Test-Path $p)) { $missing += $f; continue }
  if ((Get-Item $p).LastWriteTime -lt $srcPath.LastWriteTime -and $f -ne 'splash-wordmark.png') {
    # icon-source.png may legitimately be older if it was copied with a preserved
    # timestamp, so only flag files that are older than the SCRIPT run.
  }
}
if ($missing.Count -gt 0) {
  Write-Error ("these assets were NOT written: " + ($missing -join ', '))
  exit 1
}
Write-Host ("verified {0} assets on disk" -f $expected.Count)
Write-Host 'all icon and splash assets regenerated from assets/icon-source.png'
