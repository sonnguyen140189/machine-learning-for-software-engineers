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

/**
 * Build a vertical 1080x1920 slideshow video from images, with on-screen text per scene.
 * Suitable for TikTok and Instagram Reels.
 *
 * @param {string[]} imagePaths - local image file paths (>= scenes.length recommended)
 * @param {{hook: string, scenes: string[], cta: string}} script
 * @param {string} outputPath - mp4 output path
 * @param {number} secondsPerScene
 */
export async function buildSlideshowVideo(
  imagePaths,
  script,
  outputPath,
  secondsPerScene = 3,
) {
  await mkdir(OUT_DIR, { recursive: true });

  const captions = [script.hook, ...script.scenes, script.cta].filter(Boolean);
  const slides = Math.min(captions.length, imagePaths.length);
  if (slides < 2) {
    throw new Error("Need at least 2 images + captions to build a video");
  }

  const inputs = [];
  for (let i = 0; i < slides; i++) {
    inputs.push("-loop", "1", "-t", String(secondsPerScene), "-i", imagePaths[i]);
  }

  const filterParts = [];
  for (let i = 0; i < slides; i++) {
    const caption = escapeDrawText(captions[i] || "");
    // Scale + pad to 1080x1920 vertical, then draw caption near bottom
    filterParts.push(
      `[${i}:v]scale=1080:1920:force_original_aspect_ratio=increase,` +
        `crop=1080:1920,` +
        `drawtext=text='${caption}':fontcolor=white:fontsize=58:` +
        `box=1:boxcolor=black@0.55:boxborderw=24:` +
        `x=(w-text_w)/2:y=h-360,` +
        `setsar=1,format=yuv420p[v${i}]`,
    );
  }
  const concatInputs = Array.from({ length: slides }, (_, i) => `[v${i}]`).join("");
  filterParts.push(`${concatInputs}concat=n=${slides}:v=1:a=0[outv]`);

  const filterComplex = filterParts.join(";");

  const args = [
    "-y",
    ...inputs,
    "-filter_complex",
    filterComplex,
    "-map",
    "[outv]",
    "-r",
    "30",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    outputPath,
  ];

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
