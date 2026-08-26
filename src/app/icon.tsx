import { ImageResponse } from "next/og";

// Brand favicon — violet rounded square with a bold "F" monogram, matching
// the sidebar logo tile color (`bg-primary`) in `src/components/layout/sidebar.tsx`.
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
          background: "#7c3aed",
          borderRadius: 7,
        }}
      >
        <span
          style={{
            fontFamily: "Inter, 'Helvetica Neue', Arial, sans-serif",
            fontWeight: 700,
            fontSize: 20,
            lineHeight: 1,
            color: "#ffffff",
          }}
        >
          F
        </span>
      </div>
    ),
    { ...size },
  );
}
