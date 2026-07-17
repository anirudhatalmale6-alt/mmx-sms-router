from playwright.sync_api import sync_playwright

B = 'http://localhost:8788'
OUT = '/var/lib/freelancer/projects/40589043'

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={'width': 1280, 'height': 800})
    page.goto(B + '/dashboard')
    page.evaluate("localStorage.setItem('mmx_token','dev-admin-token-change-me')")
    page.reload()
    page.wait_for_timeout(900)
    page.screenshot(path=OUT + '/dash-customers.png')
    for tab, file in [('mo', 'dash-mo'), ('dr', 'dash-dr'), ('retry', 'dash-retry'), ('logs', 'dash-logs')]:
        page.click(f'nav a[data-tab="{tab}"]')
        page.wait_for_timeout(700)
        page.screenshot(path=f'{OUT}/{file}.png')
    print('screenshots done')
    browser.close()
