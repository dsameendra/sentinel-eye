"""Read-only settings checks against the real recorder (nothing is saved)."""
import asyncio, sys
sys.path.insert(0, "tools")
from cdp import Browser
async def main():
    async with Browser() as b:
        await b.goto("http://127.0.0.1:8080/#/settings/connection")
        await b.wait_for("document.querySelector('#t-run')", 15)
        await b.js("document.querySelector('#t-run').click()")
        await b.wait_for("document.querySelector('.result')", 40)
        print("SD test :", (await b.js("document.querySelector('.result').innerText")).replace("\n"," | "))
        await b.js("document.querySelector('[data-tk=main]').click()"); await asyncio.sleep(0.3)
        await b.js("document.querySelector('#t-run').click()")
        await b.wait_for("document.querySelector('.result')", 40)
        await asyncio.sleep(1)
        print("HD test :", (await b.js("document.querySelector('.result').innerText")).replace("\n"," | "))
        await b.js("location.hash='#/settings/channels'"); await asyncio.sleep(0.8)
        await b.js("document.querySelector('#detect').click()")
        await b.wait_for("document.querySelector('.result')", 40)
        print("detect  :", (await b.js("document.querySelector('.result').innerText")).replace("\n"," | ")[:230])
        await b.js("document.querySelector('#use-names').click()"); await asyncio.sleep(0.4)
        print("names   :", await b.js("[...document.querySelectorAll('tr[data-row] input[type=text]')].filter(e=>e.dataset.b.endsWith('.name')).map(e=>e.value).join(' | ')"))
        await b.js("document.querySelector('[data-test=\"c2\"]').click()")
        await b.wait_for("document.querySelector('.rowtest')", 50)
        print("row test:", (await b.js("document.querySelector('.rowtest').innerText")).replace("\n"," ").strip()[:200])
        await b.shot(sys.argv[1] + "/real_channels.png")
        await b.js("document.querySelector('#discard').click()")
        print("unsaved changes discarded; console:", [l for l in b.logs if 'favicon' not in l][:3])
asyncio.run(main())
