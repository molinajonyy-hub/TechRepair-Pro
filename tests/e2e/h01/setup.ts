import { readFileSync } from 'node:fs'
import { chromium } from '@playwright/test'
import { verificarMarker } from '../setup/assertLocalTarget'
import { motivoDestinoProhibido } from '../setup/destinosProhibidos'
import { localSQL, localTarget } from './local'

export default async function setup() {
  const target = localTarget()
  // The transport is a fixed local Docker container, never a database URL.
  localSQL(readFileSync('tests/e2e/setup/e2eMarker.sql', 'utf8') + "\nNOTIFY pgrst, 'reload schema';")
  let markerError: string | null = 'Local API schema cache has not loaded the marker.'
  for (let attempt = 0; attempt < 20; attempt++) {
    markerError = await verificarMarker(target.api, target.service)
    if (!markerError) break
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  if (markerError) throw new Error(markerError)

  const browser = await chromium.launch()
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' })
    const rejected: string[] = []
    await context.route('**/*', route => {
      const reason = motivoDestinoProhibido(route.request().url())
      if (reason) { rejected.push(reason); return route.abort('blockedbyclient') }
      return route.continue()
    })
    const page = await context.newPage()
    await page.goto('http://localhost:5184/landing', { waitUntil: 'networkidle' })
    const effective = await page.evaluate(() => (window as unknown as { __E2E_SUPABASE_URL__?: string }).__E2E_SUPABASE_URL__)
    if (rejected.length || effective !== target.api) throw new Error('H01 served bundle does not exclusively target the verified local stack.')
  } finally {
    await browser.close()
  }
}
