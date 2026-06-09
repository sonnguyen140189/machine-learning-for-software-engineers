import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const OUT_DIR = "out/media";

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

function escapeDrawText(text) {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "’")
    .replace(/%/g, "\\%");
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

// Build the drawtext filter(s) for a single scene. Two patterns:
//   - Non-hook scenes (sceneIdx > 0): one animated caption that slides up
//     from y=h-240 → h-340 over the first 0.3s, alpha fades in over the same
//     window, holds, then fades out over the last 0.2s before crossfade.
//   - Hook scene (sceneIdx === 0): PREPEND a "stat slam" — same hook text at
//     huge fontsize (88px) centered on screen for 0-0.5s, with a quick
//     0.1s in/out. The animated caption is delayed to start at t=0.5 so the
//     punch hands off cleanly. This is what turns "first frame is a photo
//     with a caption box" into "first frame is a punch in the face."
//
// Comma-escape rules: ffmpeg parses filter chains on `,`. Inside expressions
// we use `\\,` (which becomes `\,` in the actual ffmpeg arg string, telling
// the expression parser "this is a literal comma, not a filter separator").
function buildDrawtextLayers(captionText, sceneIdx, sceneSeconds) {
  const FADE_IN = 0.3;
  const FADE_OUT = 0.2;
  const PUNCH_END = 0.5;
  const isHook = sceneIdx === 0;
  const startT = isHook ? PUNCH_END : 0;
  const fadeOutStart = (sceneSeconds - FADE_OUT).toFixed(2);
  // localT = scene-local time, reset to 0 when this caption layer activates.
  // For non-hook scenes that's just t. For hook scene, the caption layer
  // activates at t=0.5 so we use (t-0.5).
  const localT = startT === 0 ? "t" : `(t-${startT})`;

  const wrapped = wrapForOverlay(captionText || "");
  const captionEsc = escapeDrawText(wrapped).replace(/\n/g, "\\n");
  const captionLayer =
    `drawtext=fontfile=assets/fonts/Poppins-Bold.ttf:` +
    `text='${captionEsc}':fontcolor=white:fontsize=52:` +
    `line_spacing=12:` +
    `box=1:boxcolor=0x0288D1@0.78:boxborderw=28:` +
    `x=(w-text_w)/2:` +
    `y='if(lt(${localT}\\,${FADE_IN})\\, h-340+100*(${FADE_IN}-${localT})/${FADE_IN}\\, h-340)':` +
    `alpha='if(lt(${localT}\\,${FADE_IN})\\, ${localT}/${FADE_IN}\\, if(gt(t\\,${fadeOutStart})\\, max(0\\,(${sceneSeconds}-t)/${FADE_OUT})\\, 1))':` +
    `enable='gte(t\\,${startT})'`;

  if (!isHook) return captionLayer;

  // Hook scene: BIG centered punch with the same caption text.
  // Wrap shorter (14 chars/line) so fontsize 88 doesn't overflow 1080px wide.
  const punchWrapped = wrapForOverlay(captionText || "", 14);
  const punchEsc = escapeDrawText(punchWrapped).replace(/\n/g, "\\n");
  const punchLayer =
    `drawtext=fontfile=assets/fonts/Poppins-Bold.ttf:` +
    `text='${punchEsc}':fontcolor=white:fontsize=88:` +
    `line_spacing=14:` +
    `box=1:boxcolor=0x0288D1@0.92:boxborderw=36:` +
    `x=(w-text_w)/2:y=(h-text_h)/2:` +
    `enable='lt(t\\,${PUNCH_END})':` +
    `alpha='if(lt(t\\,0.1)\\, t/0.1\\, if(gt(t\\,0.4)\\, (${PUNCH_END}-t)/0.1\\, 1))'`;

  return `${punchLayer},${captionLayer}`;
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
  // Ken Burns config — slow zoom over the scene. Alternating direction
  // (even = zoom in / push, odd = zoom out / pull) breaks the monotony
  // of every photo doing the same thing.
  const fps = 30;
  const sceneFrames = Math.round(secondsPerScene * fps);
  const zoomSpeed = 0.002; // ~0.12 zoom delta over a 2s scene at 30fps
  const maxZoom = 1.15;

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

  const filterParts = [];
  for (let i = 0; i < slides; i++) {
    const isVideo = mediaList[i].type === "video";
    // One or two drawtext filters per scene — see buildDrawtextLayers for the
    // hook-scene "punch + caption handoff" vs the standard animated caption.
    const drawtextLayers = buildDrawtextLayers(captions[i] || "", i, secondsPerScene);

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
      // Ken Burns: alternate zoom direction per scene. `on` is the output
      // frame index inside zoompan; we compute z from it directly so the
      // motion is linear and predictable regardless of zoompan's internal
      // accumulation quirks.
      const zoomIn = i % 2 === 0;
      const zExpr = zoomIn
        ? `min(1.0+on*${zoomSpeed}\\,${maxZoom})`
        : `max(${maxZoom}-on*${zoomSpeed}\\,1.0)`;
      filterParts.push(
        `[${i}:v]scale=2160:3840:force_original_aspect_ratio=increase,` +
          `crop=2160:3840,` +
          `zoompan=z='${zExpr}':d=${sceneFrames}:s=1080x1920:` +
          `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':fps=${fps},` +
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

  await run("ffmpeg", args);
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
