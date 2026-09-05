# DJ Toolkit Web V10.5.1 – Root Image Path Fix

Your GitHub screenshot shows the feature images directly inside `GuestWeb/`,
for example:

- `GuestWeb/booth-safety.webp`
- `GuestWeb/genre-voting.webp`
- `GuestWeb/event-music-direction.webp`
- `GuestWeb/request-genre-detection.webp`
- `GuestWeb/feedback.webp`
- `GuestWeb/new-features.webp`

V10.5 originally referenced them under `/assets/features/...`.
This build updates all landing-page image and lightbox URLs to the actual
root locations, so the images load without moving files in GitHub.
