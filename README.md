# 拼豆实验 · Perler Bead Pilot

A two-role, multi-round communication experiment. The Speaker sees a normal source image; the Listener reconstructs it from confirmed text. After both participants end communication, the source is revealed and they create a blank-initialized 12×12 pair consensus together.

Files:

- `index.html`: participant experiment
- `experiment_v2.js`: transcription, trial, ending, and consensus flow
- `research_dashboard.html`: researcher timeline and JSON/API import

This GitHub Pages build supports manual text, peer-to-peer rooms, JSON export, and dashboard imports. Chinese/English voice transcription and centralized collection require the separate experiment server, supplied with the `?api=https://server.example` query parameter. No API or researcher secret belongs in this repository.
