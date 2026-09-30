"use client"

import * as React from "react"
import { Switch as SwitchPrimitive } from "@base-ui/react/switch"

import { cn } from "@/lib/utils"

// Root: primary token when checked (responds to the active color theme),
// slate when unchecked.
function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 transition-colors",
        // A transparent border relied on the track color alone for
        // contrast against the page. In dark mode, --background/--card/
        // --muted are all within a few percent of each other in
        // lightness, so an unchecked switch was nearly invisible (user-
        // reported: the automation builder's "Ativa" toggle couldn't be
        // seen at all in dark mode). A real border color, always
        // present, keeps the control visibly outlined in both themes
        // regardless of how close the fill color is to the background.
        "border-border data-[checked]:border-primary",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "data-[checked]:bg-primary data-[unchecked]:bg-muted",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block h-4 w-4 rounded-full shadow-sm ring-0 transition-transform",
          "data-[checked]:translate-x-4 data-[unchecked]:translate-x-0",
          // Red dot when off, not just a neutral card-colored one —
          // every use of this switch in the app is an enable/disable
          // toggle (automation, webhook connection, WhatsApp channel,
          // notification, AI reply), so "off" is never a neutral state
          // worth blending in; it should read as "click to turn on".
          "data-[unchecked]:bg-destructive data-[checked]:bg-card",
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
