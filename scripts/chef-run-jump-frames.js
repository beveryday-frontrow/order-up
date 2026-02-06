#!/usr/bin/env node
/**
 * Util for updating frame values from chef-run-jump.png (or any horizontal strip sprite).
 * Reads PNG dimensions, computes frame layout, and prints CSS/JS values for the loading-stage game.
 *
 * Usage:
 *   node scripts/chef-run-jump-frames.js [imagePath] [numFrames] [displayHeight]
 *
 * Examples:
 *   node scripts/chef-run-jump-frames.js
 *   node scripts/chef-run-jump-frames.js app/public/images/chef-run-jump.png 4 64
 */

const { readFileSync } = require("fs");
const { resolve, dirname } = require("path");

const ROOT = resolve(dirname(__dirname));
const PNG_SIG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function readPngDimensions(filePath) {
  const buf = readFileSync(filePath);
  if (buf.length < 24 || Buffer.compare(buf.subarray(0, 8), Buffer.from(PNG_SIG)) !== 0) {
    throw new Error("Not a valid PNG or file too small");
  }
  // IHDR: width at 16, height at 20 (big-endian)
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}

const imagePath = resolve(ROOT, process.argv[2] || "app/public/images/chef-run-jump.png");
const numFrames = Math.max(1, parseInt(process.argv[3], 10) || 4);
const displayHeight = Math.max(1, parseInt(process.argv[4], 10) || 64);

let imageWidth, imageHeight;
try {
  ({ width: imageWidth, height: imageHeight } = readPngDimensions(imagePath));
} catch (e) {
  console.error("Error reading image:", e.message);
  process.exit(1);
}

const frameWidthImage = imageWidth / numFrames;
const frameHeightImage = imageHeight;
const scale = displayHeight / frameHeightImage;
const displayFrameWidth = Math.round(frameWidthImage * scale);
const backgroundSizeW = displayFrameWidth * numFrames;
const backgroundSizeH = displayHeight;

console.log("chef-run-jump sprite frame util");
console.log("--------------------------------");
console.log("Image:", imagePath.replace(ROOT + "/", ""));
console.log("Image size:", imageWidth, "x", imageHeight);
console.log("Frames:", numFrames, "horizontal");
console.log("Frame size (in image):", Math.round(frameWidthImage), "x", frameHeightImage);
console.log("");
console.log("Display (height = " + displayHeight + "px):");
console.log("  Frame size:", displayFrameWidth, "x", backgroundSizeH);
console.log("");
console.log("CSS:");
console.log("  background-size: " + backgroundSizeW + "px " + backgroundSizeH + "px;");
console.log("  width: " + displayFrameWidth + "px;");
console.log("  height: " + backgroundSizeH + "px;");
console.log("");
console.log("JS (per-frame background-position-x):");
console.log("  backgroundPosition = (-frameIndex * " + displayFrameWidth + ") + 'px 0';");
console.log("");
console.log("Frame index: 0,1 = run; 2 = jump (if 4 frames).");
