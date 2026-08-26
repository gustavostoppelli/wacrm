import { ImageResponse } from "next/og";

// Link-preview image (WhatsApp/Slack/Twitter/etc unfurl cards). Next.js
// auto-detects this file convention and injects the right <meta> tags —
// no manual metadata wiring needed. Also used as the Twitter card image
// since no separate twitter-image route is defined.

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
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "#020617",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 28,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 120,
              height: 120,
              borderRadius: 28,
              background: "#0A5E4E",
            }}
          >
            <span
              style={{
                fontFamily: "Inter, 'Helvetica Neue', Arial, sans-serif",
                fontWeight: 700,
                fontSize: 72,
              }}
            >
              <span style={{ color: "#F2EDE1" }}>f</span>
              <span style={{ color: "#D8C08A" }}>.</span>
            </span>
          </div>
          <span
            style={{
              fontFamily: "Inter, 'Helvetica Neue', Arial, sans-serif",
              fontWeight: 700,
              fontSize: 96,
              color: "#f8fafc",
            }}
          >
            FuseHub
          </span>
        </div>
        <span
          style={{
            marginTop: 32,
            fontFamily: "Inter, 'Helvetica Neue', Arial, sans-serif",
            fontWeight: 500,
            fontSize: 34,
            color: "#D8C08A",
          }}
        >
          CRM com IA para vendas e atendimento no WhatsApp
        </span>
      </div>
    ),
    { ...size },
  );
}
