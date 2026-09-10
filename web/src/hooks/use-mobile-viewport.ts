import { useEffect, useRef } from "react"

/** Safari resizes the visual viewport, rather than dvh, when its keyboard opens. */
export function useMobileViewport(enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = ref.current
    const viewport = window.visualViewport
    if (!enabled || !element || !viewport) return
    const update = () => {
      // Let pinch zoom pan naturally; shrinking the app during zoom traps content.
      if (viewport.scale !== 1) return
      element.style.setProperty("--mobile-height", `${viewport.height}px`)
      element.style.setProperty("--mobile-top", `${viewport.offsetTop}px`)
      const keyboard = window.innerHeight - viewport.height > 150
      element.style.setProperty("--mobile-bottom", keyboard ? "0px" : "env(safe-area-inset-bottom)")
      // Installed iOS apps need the bottom safe-area extension while resting,
      // but it must not extend the shell behind an open keyboard.
      if (keyboard) element.style.setProperty("--mobile-viewport-extension", "0px")
      else element.style.removeProperty("--mobile-viewport-extension")
    }
    update()
    viewport.addEventListener("resize", update)
    viewport.addEventListener("scroll", update)
    return () => {
      viewport.removeEventListener("resize", update)
      viewport.removeEventListener("scroll", update)
      for (const name of ["--mobile-height", "--mobile-top", "--mobile-bottom", "--mobile-viewport-extension"]) element.style.removeProperty(name)
    }
  }, [enabled])
  return ref
}
