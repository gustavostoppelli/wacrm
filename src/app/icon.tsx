import { ImageResponse } from "next/og";

// Brand favicon — Emerald Palace background with the "f." monogram,
// matching the Fuse brand mark (see fuse-monograma-emerald.svg) and the
// app's default Emerald accent theme (`DEFAULT_THEME` in src/lib/themes.ts).
// Next.js renders this at build time and auto-injects <link rel="icon"> into <head>.
//
// This route takes precedence over src/app/favicon.ico, which is the
// Next.js default and can stay on disk harmlessly (or be removed).

export const runtime = "edge";
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0A5E4E",
          borderRadius: 7,
        }}
      >
        <span
          style={{
            fontFamily: "Inter, 'Helvetica Neue', Arial, sans-serif",
            fontWeight: 700,
            fontSize: 20,
            lineHeight: 1,
          }}
        >
          <span style={{ color: "#F2EDE1" }}>f</span>
          <span style={{ color: "#D8C08A" }}>.</span>
        </span>
      </div>
    ),
    { ...size },
  );
}
