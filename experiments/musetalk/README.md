# Otter × MuseTalk — experiment

Exploring replacing the current **Rhubarb viseme + mouth-PNG-swap** animation
with **MuseTalk** (audio-driven neural lip-sync). This folder is R&D only — it is
NOT wired into the live pipeline.

- `MuseTalk_Otter_Test.ipynb` — open in Google Colab (free **T4 GPU**), runs
  MuseTalk on an otter image/video + an audio clip and shows the result.

## ⚠️ Read this first — why the imagery matters

MuseTalk is trained on **real human faces**. It detects a face, crops a
**256×256** region, and inpaints a mouth driven by the audio. It is documented to
struggle with cartoons **"because the cartoon character's lips themselves are
often missing."** Our current otter is exactly that failure case: a flat snout
with a tiny line for a mouth.

So the plan is right: **give MuseTalk imagery it can actually drive.** The single
biggest lever is **a clearly defined mouth with lips and a dark interior.**

## Imagery spec — what to make for the otter

### Format (pick one)
- **Best: a short driving video** — 5–15 s, **25 fps**, looping, of the otter at
  the desk with subtle idle life baked in: occasional **blink**, slight head
  sway, breathing. MuseTalk only repaints the **mouth**; everything else (eyes,
  head motion) comes from this clip, so bake the "alive" motion here.
- **OK: a single high-res still.** Result is a static head with only the mouth
  moving — usable for the test, less lively for production.

### The face (this is what makes or breaks it)
1. **Frontal, camera-facing**, head upright, face filling a large central part of
   the frame (a tiny head → blurry 256² mouth).
2. **A real mouth with an upper and lower lip and a hint of dark interior** in the
   base/neutral frame — give MuseTalk something to open and close into. This is
   the #1 fix vs the current art.
3. **Slightly parted, neutral mouth** in the base frame (not clamped shut).
4. **Human-ish facial layout helps detection** — eyes / nose / mouth in a roughly
   human top-to-bottom arrangement. A **shorter, less dominant snout** with the
   mouth front-and-center detects far better than a long realistic otter muzzle.
   Lean "humanoid otter," not "wildlife otter."
5. **Even, soft lighting**, no harsh shadow across the mouth; mouth not occluded
   by the bow tie.

### Framing / branding
MuseTalk edits only the mouth region, so you can **keep your look**: produce the
otter head/upper body, run MuseTalk, then composite the result over your existing
**wall + desk background and the lower-third banner** with the same ffmpeg overlay
the renderer already does. (Or feed MuseTalk the fully-framed scene — it still
only touches the mouth.)

### The style trade-off to decide
The more human/defined you make the mouth for MuseTalk, the further you drift from
the charming flat cartoon you have now. Worth a deliberate call: a semi-realistic
"3D-ish" otter anchor lip-syncs best; a flat 2D cartoon fights the model.

## How to run the test
1. Open `MuseTalk_Otter_Test.ipynb` in Colab → Runtime → Change runtime type →
   **T4 GPU**.
2. Run the cells top to bottom (install + weights take ~5–10 min the first time).
3. Upload an otter image/video **and** an audio clip (or generate one with the
   optional Piper cell — same voice as the live pipeline).
4. Tune **`bbox_shift`** if the mouth is too closed/open (positive = more open).
5. Eyeball the result. Start by testing the **existing** `assets/mouths/X.png` to
   see the baseline failure, then iterate on new imagery.

## Productionizing (later, only if results are good)
Colab can't be the live renderer (ephemeral, no stable endpoint) and the hub is
CPU-only. Going live with MuseTalk means a **GPU** (always-on GPU instance or a
paid render API) — a new cost. Keep that in mind before adopting; the current
viseme renderer stays the production path until/unless this clearly wins.
