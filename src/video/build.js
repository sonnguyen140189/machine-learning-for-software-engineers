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
  secondsPerScene = 3,
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
  const zoomSpeed = 0.0013; // ~0.12 zoom delta over a 3s scene
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
    // Wrap first, escape second, then convert real newlines to the literal
    // "\n" sequence that ffmpeg drawtext expands back to line breaks.
    const wrapped = wrapForOverlay(captions[i] || "");
    const caption = escapeDrawText(wrapped).replace(/\n/g, "\\n");
    const isVideo = mediaList[i].type === "video";

    const drawtextFilter =
      `drawtext=fontfile=assets/fonts/Poppins-Bold.ttf:` +
      `text='${caption}':fontcolor=white:fontsize=52:` +
      `line_spacing=12:` +
      `box=1:boxcolor=0x0288D1@0.78:boxborderw=28:` +
      `x=(w-text_w)/2:y=h-440`;

    if (isVideo) {
      // B-roll already has natural motion — skip Ken Burns. Trim to scene
      // length, normalize timestamps, force the same fps/SAR/pixfmt as
      // photo scenes so xfade can splice them together cleanly.
      filterParts.push(
        `[${i}:v]trim=duration=${secondsPerScene},setpts=PTS-STARTPTS,` +
          `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,` +
          `fps=${fps},${drawtextFilter},` +
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
          `${drawtextFilter},` +
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
