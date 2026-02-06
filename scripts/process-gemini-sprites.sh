#!/usr/bin/env bash
# Move Gemini sprite images to public/images, rename, and remove white/light-grey background.
set -e
ASSETS="/Users/brandonevery/.cursor/projects/Users-brandonevery-Projects-pr-watcher/assets"
OUT="/Users/brandonevery/Projects/pr-watcher/app/public/images"

# src_filename -> output name (by content from descriptions)
process() {
  local src="$1"
  local name="$2"
  local outpath="$OUT/$name.png"
  echo "  $name.png"
  # Remove white and light grey (#f2f2f2) background; 30% fuzz catches off-whites
  magick "$src" -fuzz 30% -transparent white -fuzz 30% -transparent "#f2f2f2" "$outpath"
}

echo "Processing Gemini sprites (remove white/light grey background)..."
process "$ASSETS/Gemini_Generated_Image_dvitqfdvitqfdvit-1aa393f0-bf56-4771-97a6-c16f7a88fbde.png" "chef-walk-cycle"
process "$ASSETS/Gemini_Generated_Image_my2alfmy2alfmy2a-67e82bea-dcf6-471a-afd3-7def32b024d4.png" "chef-idle-attack"
process "$ASSETS/Gemini_Generated_Image_tkfqa4tkfqa4tkfq-6f1c47ec-4c29-49d4-a909-44560baa05ca.png" "chef-idle-bob"
process "$ASSETS/Gemini_Generated_Image_gk3shcgk3shcgk3s-9494a88e-b49b-4232-94a5-eef53ac96285.png" "chef-poses"
process "$ASSETS/Gemini_Generated_Image_8rytxl8rytxl8ryt-841d37c8-18c3-49b7-b0b3-e8e67f0f2fe4.png" "chef-run-cycle"
process "$ASSETS/Gemini_Generated_Image_cvw784cvw784cvw7-5db009fe-2dc4-41f6-8aaf-52bd8971ff90.png" "chef-hurt-debris"
process "$ASSETS/Gemini_Generated_Image_p6h5eyp6h5eyp6h5-58a97431-3926-4aaf-bee6-67e0f2ddf191.png" "chef-flamethrower-4"
process "$ASSETS/Gemini_Generated_Image_rdr06trdr06trdr0-779b4a48-d89f-406e-b959-eeedfe7ae844.png" "chef-flamethrower-3"
process "$ASSETS/Gemini_Generated_Image_7e13x17e13x17e13-bd7c680c-b114-4c8c-8c60-c3b31f810373.png" "chef-spatula-attack"
process "$ASSETS/Gemini_Generated_Image_mne582mne582mne5-cc844442-5a30-4e3e-9027-121e548f8480.png" "chef-overhead-attack"
process "$ASSETS/Gemini_Generated_Image_bjjzv1bjjzv1bjjz-5574fe3a-fb15-4f3d-86a2-15eddffc2bd1.png" "chef-flamethrower"
echo "Done. Output: $OUT/"
ls -la "$OUT"/chef-*.png 2>/dev/null | tail -15
