import { spawn } from "node:child_process";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";

const OUT_DIR = "out/media";

// On-screen text is drawn via drawtext `textfile=` (not inline `text=`), so the
// file content is rendered literally — no escaping of commas, colons, quotes,
// or newlines needed. The only thing we must fix is glyphs the bundled font
// can't draw: Poppins-Bold has no ★ (U+2605), which otherwise renders as a
// tofu box. Replace "4.8★" → "4.8 stars" and collapse any doubled spaces.
function sanitizeOverlayText(text) {
  return String(text || "")
    .replace(/\s*★/g, " stars")
    .replace(/[ \t]{2,}/g, " ")
    .trimEnd();
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}\n${stderr}`));
    });
  });
}

// Greedy word-wrap so on-screen captions never overflow the 1080px frame.
// At fontsize 46, ~28 chars per line fits with comfortable margins.
function wrapForOverlay(text, maxCharsPerLine = 28) {
  const words = String(text || "").trim().split(/\s+/);
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxCharsPerLine && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.join("\n");
}

// Interleave B-roll clips between photo scenes so the slideshow alternates
// stills with real motion. Standard layout for 6 slides + 2 B-roll inputs:
//   photo, photo, BROLL, photo, BROLL, photo
// (B-roll lands at indices 2 and 4 of the final 6-scene sequence). When
// brollPaths has fewer than 2 items we just append what we have without
// disturbing the photo positions; captions stay 1:1 with final scenes.
function interleaveScenes(imagePaths, brollPaths) {
  if (!brollPaths.length) return imagePaths.map((p) => ({ type: "image", path: p }));
  const photos = imagePaths.map((p) => ({ type: "image", path: p }));
  const broll = brollPaths.map((p) => ({ type: "video", path: p }));
  // Fixed insertion points keep the rhythm predictable: B-roll at slot 2 and 4.
  const slots = [0, 1, "broll", 2, "broll", 3];
  const out = [];
  let brollIdx = 0;
  for (const s of slots) {
    if (s === "broll") {
      if (brollIdx < broll.length) out.push(broll[brollIdx++]);
    } else if (s < photos.length) {
      out.push(photos[s]);
    }
  }
  return out;
}

// Build the drawtext filter for a single scene. The caption text lives in a
// file referenced by `textfile=` (written by the caller) so it renders
// literally — no escaping of commas, quotes, or newlines. Two patterns:
//   - Hook scene (sceneIdx === 0): ONE big centered "slam" of the hook text,
//     held for the whole scene (fade in 0.3s, hold, fade out 0.2s). Earlier
//     this rendered the hook BOTH as a big punch AND again as a small caption
//     underneath — viewers saw the first line twice, which read as a bug.
//     Now the hook appears exactly once.
//   - Other scenes (sceneIdx > 0): one animated caption that slides up from
//     y=h-240 → h-340 over the first 0.3s, alpha fades in, holds, fades out
//     over the last 0.2s before the crossfade.
function buildDrawtextLayers(textfilePath, sceneIdx, sceneSeconds) {
  const FADE_IN = 0.3;
  const FADE_OUT = 0.2;
  const fadeOutStart = (sceneSeconds - FADE_OUT).toFixed(2);
  // Shared alpha curve: fade in over FADE_IN, hold, fade out over FADE_OUT.
  // `\\,` escapes the commas for the expression parser (becomes `\,` at run).
  const alphaExpr =
    `if(lt(t\\,${FADE_IN})\\, t/${FADE_IN}\\, ` +
    `if(gt(t\\,${fadeOutStart})\\, max(0\\,(${sceneSeconds}-t)/${FADE_OUT})\\, 1))`;
  // textfile path is wrapped in single quotes so `:`/`,` in a path can't be
  // mistaken for option separators. Our paths are ASCII and contain neither.
  const tf = `textfile='${textfilePath}'`;

  if (sceneIdx === 0) {
    // Hook: one big centered slam, shown once for the full scene.
    return (
      `drawtext=fontfile=assets/fonts/Poppins-Bold.ttf:` +
      `${tf}:fontcolor=white:fontsize=76:` +
      `line_spacing=14:` +
      `box=1:boxcolor=0x0288D1@0.9:boxborderw=34:` +
      `x=(w-text_w)/2:y=(h-text_h)/2:` +
      `alpha='${alphaExpr}'`
    );
  }

  return (
    `drawtext=fontfile=assets/fonts/Poppins-Bold.ttf:` +
    `${tf}:fontcolor=white:fontsize=52:` +
    `line_spacing=12:` +
    `box=1:boxcolor=0x0288D1@0.78:boxborderw=28:` +
    `x=(w-text_w)/2:` +
    `y='if(lt(t\\,${FADE_IN})\\, h-340+100*(${FADE_IN}-t)/${FADE_IN}\\, h-340)':` +
    `alpha='${alphaExpr}'`
  );
}

/**
 * Build a vertical 1080x1920 slideshow video from images (and optional B-roll
 * clips), with on-screen text per scene. Suitable for TikTok and Reels.
 *
 * @param {string[]} imagePaths - local image file paths (>= scenes.length recommended)
 * @param {{hook: string, scenes: string[], cta: string}} script
 * @param {string} outputPath - mp4 output path
 * @param {number} secondsPerScene
 * @param {string | null} musicPath - optional audio track to mix under the video; looped to length, 1s fade-in/out, volume 60%
 * @param {string[]} brollPaths - optional pre-cropped 1080x1920 mp4 paths to interleave
 */
export async function buildSlideshowVideo(
  imagePaths,
  script,
  outputPath,
  secondsPerScene = 2,
  musicPath = null,
  brollPaths = [],
) {
  await mkdir(OUT_DIR, { recursive: true });

  const captions = [script.hook, ...script.scenes, script.cta].filter(Boolean);
  const mediaList = interleaveScenes(imagePaths, brollPaths);
  const slides = Math.min(captions.length, mediaList.length);
  if (slides < 2) {
    throw new Error("Need at least 2 scenes + captions to build a video");
  }
  // Each crossfade overlaps two streams by xfadeDuration seconds, so the
  // total runtime is shorter than naive N * secondsPerScene.
  const xfadeDuration = 0.5;
  const totalDuration = slides * secondsPerScene - (slides - 1) * xfadeDuration;
  // Motion config. We no longer zoom/crop the photo itself — cropping a square
  // or landscape photo into a 9:16 frame and then zooming it cut off most of
  // the subject, which read as "the picture is being chopped up." Instead each
  // photo scene is composited: a BLURRED copy of the photo fills the frame as a
  // backdrop (gentle zoom lives here, where cropping doesn't matter because
  // it's blurred), and the FULL photo sits sharp and uncropped on top. The
  // zoom delta below applies only to that blurred backdrop.
  const fps = 30;
  const sceneFrames = Math.round(secondsPerScene * fps);
  const bgZoomSpeed = 0.0016; // ~0.10 zoom delta over a 2s scene on the backdrop
  const bgMaxZoom = 1.12;
  const blurSigma = 22; // heavy gaussian so the backdrop reads as ambient color

  const inputs = [];
  for (let i = 0; i < slides; i++) {
    // For images: feed a single still frame so zoompan owns the timing.
    // Earlier we used `-loop 1 -t <sec>`, which at ffmpeg's default 25fps
    // produced ~75 input frames; zoompan d=N then emitted N frames PER input
    // frame, ballooning a 3s scene to ~225s. Just `-i image.jpg` reads exactly
    // one frame, so zoompan d=sceneFrames@fps=30 yields exactly secondsPerScene.
    //
    // For B-roll: just `-i clip.mp4` — the clip was already cropped to
    // 1080×1920 and trimmed to scene length during download.
    inputs.push("-i", mediaList[i].path);
  }
  if (musicPath) {
    // -stream_loop -1 makes ffmpeg replay the track until we cut it with
    // atrim below, so short clips still cover a 18-21s slideshow.
    inputs.push("-stream_loop", "-1", "-i", musicPath);
  }

  // Write each scene's caption to a sidecar .txt file that drawtext reads via
  // textfile=. Rendered literally — no comma/quote/newline escaping. Hook scene
  // wraps tighter (16 chars) for its bigger 76px font; others use the 28-char
  // default. These files are cleaned up after ffmpeg runs.
  const textfilePaths = [];
  for (let i = 0; i < slides; i++) {
    const wrapWidth = i === 0 ? 16 : 28;
    const overlayText = sanitizeOverlayText(wrapForOverlay(captions[i] || "", wrapWidth));
    const tfPath = `${outputPath}.s${i}.txt`;
    await writeFile(tfPath, overlayText, "utf8");
    textfilePaths.push(tfPath);
  }

  const filterParts = [];
  for (let i = 0; i < slides; i++) {
    const isVideo = mediaList[i].type === "video";
    const drawtextLayers = buildDrawtextLayers(textfilePaths[i], i, secondsPerScene);

    if (isVideo) {
      // B-roll already has natural motion — skip Ken Burns. Trim to scene
      // length, normalize timestamps, force the same fps/SAR/pixfmt as
      // photo scenes so xfade can splice them together cleanly.
      filterParts.push(
        `[${i}:v]trim=duration=${secondsPerScene},setpts=PTS-STARTPTS,` +
          `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,` +
          `fps=${fps},${drawtextLayers},` +
          `setsar=1,format=yuv420p[v${i}]`,
      );
    } else {
      // Blurred-background composition. split the single still frame into a
      // backdrop and a foreground:
      //   - backdrop: fill 9:16 (crop ok, it's blurred), gentle zoom for life,
      //     then a heavy gaussian blur so it reads as ambient colour.
      //   - foreground: scale to FIT inside 9:16 (decrease = never crop), so the
      //     whole photo is always visible. overlay centers it.
      // overlay's default eof_action=repeat holds the single foreground frame
      // across all backdrop frames, so the result runs the full scene length.
      const zoomIn = i % 2 === 0;
      const zExpr = zoomIn
        ? `min(1.0+on*${bgZoomSpeed}\\,${bgMaxZoom})`
        : `max(${bgMaxZoom}-on*${bgZoomSpeed}\\,1.0)`;
      filterParts.push(
        `[${i}:v]split=2[bg${i}][fg${i}];` +
          `[bg${i}]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,` +
          `zoompan=z='${zExpr}':d=${sceneFrames}:s=1080x1920:` +
          `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':fps=${fps},` +
          `gblur=sigma=${blurSigma}[bgb${i}];` +
          `[fg${i}]scale=1080:1920:force_original_aspect_ratio=decrease,setsar=1[fgf${i}];` +
          `[bgb${i}][fgf${i}]overlay=(W-w)/2:(H-h)/2,` +
          `${drawtextLayers},` +
          `setsar=1,format=yuv420p[v${i}]`,
      );
    }
  }
  // Chain xfade transitions between consecutive scenes. xfade overlaps two
  // streams by xfadeDuration; the offset is the time from the start of the
  // accumulated stream at which the next scene should begin fading in.
  // offset(i) for the i-th xfade (0-indexed) = (i + 1) * (secondsPerScene - xfadeDuration)
  let prevLabel = "v0";
  for (let i = 0; i < slides - 1; i++) {
    const nextLabel = i === slides - 2 ? "outv" : `x${i}`;
    const offset = ((i + 1) * (secondsPerScene - xfadeDuration)).toFixed(2);
    filterParts.push(
      `[${prevLabel}][v${i + 1}]xfade=transition=fade:` +
        `duration=${xfadeDuration}:offset=${offset}[${nextLabel}]`,
    );
    prevLabel = nextLabel;
  }

  // Audio: pad-or-trim to video length, gentle fade in/out, drop the music
  // to 60% so the on-screen text still draws the eye over the rhythm.
  if (musicPath) {
    const musicIdx = slides;
    const fadeOutStart = Math.max(0, totalDuration - 1).toFixed(2);
    filterParts.push(
      `[${musicIdx}:a]atrim=duration=${totalDuration},` +
        `afade=t=in:st=0:d=1,afade=t=out:st=${fadeOutStart}:d=1,` +
        `volume=0.6[outa]`,
    );
  }

  const filterComplex = filterParts.join(";");

  const args = ["-y", ...inputs, "-filter_complex", filterComplex, "-map", "[outv]"];
  if (musicPath) args.push("-map", "[outa]", "-c:a", "aac", "-b:a", "128k", "-shortest");
  args.push(
    "-r", "30",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    outputPath,
  );

  try {
    await run("ffmpeg", args);
  } finally {
    // Remove the per-scene caption sidecar files so they're never committed.
    await Promise.all(textfilePaths.map((p) => unlink(p).catch(() => {})));
  }
  return outputPath;
}

// CLI test
if (import.meta.url === `file://${process.argv[1]}`) {
  // Generate a couple of solid-color test frames
  await mkdir(OUT_DIR, { recursive: true });
  const f1 = join(OUT_DIR, "_test1.jpg");
  const f2 = join(OUT_DIR, "_test2.jpg");
  await run("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=teal:s=1080x1920:d=1", "-frames:v", "1", f1]);
  await run("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=coral:s=1080x1920:d=1", "-frames:v", "1", f2]);
  const out = join(OUT_DIR, "_test.mp4");
  await buildSlideshowVideo(
    [f1, f2],
    { hook: "Test hook", scenes: ["Scene 1"], cta: "Follow for more" },
    out,
  );
  console.log("Built", out);
}
