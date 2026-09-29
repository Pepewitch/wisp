import { lazy, Suspense } from "react"

// The design gallery is a contributor's route (#/gallery): its specimens and
// fixtures load when someone opens it, not with every page.
const Gallery = lazy(() => import("@/components/gallery").then((module) => ({ default: module.Gallery })))

export function LazyGallery() {
  return (
    <Suspense fallback={null}>
      <Gallery />
    </Suspense>
  )
}
