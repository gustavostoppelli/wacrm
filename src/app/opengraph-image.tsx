import { ImageResponse } from "next/og";

// Link-preview image (WhatsApp/Slack/Twitter/etc unfurl cards). Next.js
// auto-detects this file convention and injects the right <meta> tags —
// no manual metadata wiring needed. Also used as the Twitter card image
// since no separate twitter-image route is defined.
//
// Deliberately just a scaled-up version of the favicon (src/app/icon.tsx)
// filling the whole canvas edge-to-edge, rather than a wordmark+tagline
// composition — several chat apps (WhatsApp included) crop this down to
// a small square thumbnail instead of showing it full-size, and a
// centered monogram on a flat brand color survives that crop no matter
// where it's taken from. Title/description still come through as text
// via the surrounding og:title/og:description meta tags.

export const runtime = "edge";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
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
        }}
      >
        <span
          style={{
            fontFamily: "Inter, 'Helvetica Neue', Arial, sans-serif",
            fontWeight: 700,
            fontSize: 340,
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
