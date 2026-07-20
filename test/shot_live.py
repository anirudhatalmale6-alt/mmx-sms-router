from playwright.sync_api import sync_playwright

B = 'https://mmx-sms-router.feedstorellc.workers.dev'
TOKEN = 'ee4cbd15e8317b64ef9ba3eafe813f51264115cd92a02a92'
OUT = '/var/lib/freelancer/projects/40589043'

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={'width': 1280, 'height': 800})
    page.goto(B + '/dashboard')
    page.evaluate(f"localStorage.setItem('mmx_token','{TOKEN}')")
    page.reload()
    page.wait_for_timeout(1200)
    page.screenshot(path=OUT + '/live-customers.png')
    for tab, file in [('mo', 'live-mo'), ('dr', 'live-dr'), ('retry', 'live-retry'), ('logs', 'live-logs')]:
        try:
            page.click(f'nav a[data-tab="{tab}"]')
            page.wait_for_timeout(800)
            page.screenshot(path=f'{OUT}/{file}.png')
        except Exception as e:
            print('tab', tab, 'err', e)
    print('screenshots done')
    browser.close()
