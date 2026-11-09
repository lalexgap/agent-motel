from pathlib import Path
import sys
sys.path.insert(0, '/tmp/pr150-shepherd-PSv1li/python')
import pyte
from PIL import Image, ImageDraw, ImageFont
root=Path('/tmp/pr150-shepherd-PSv1li')
font=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',16)
colors={'black':'#15171a','red':'#ff6262','green':'#7acc85','brown':'#e6c56c','blue':'#79a6f6','magenta':'#c797ef','cyan':'#6ecad4','white':'#e4e6eb','default':'#e4e6eb','brightred':'#ff8c8c','brightgreen':'#9ee5a6','brightyellow':'#ffe18c','brightblue':'#a0bdff','brightmagenta':'#e0bbff','brightcyan':'#a4eaf0','brightwhite':'#ffffff','brightblack':'#80858f'}
def color(c, default):
    if c=='default': return default
    return colors.get(c, '#'+c if len(c)==6 else default)
for p in root.glob('*.ansi'):
    screen=pyte.Screen(100,30); pyte.Stream(screen).feed(p.read_bytes().decode())
    im=Image.new('RGB',(1040,650),'#15171a'); d=ImageDraw.Draw(im)
    d.text((20,8),f'PR150 safe fixture | {p.stem} | c7ce541',fill='#9aa1ad',font=font)
    for y in range(30):
        for x in range(100):
            c=screen.buffer[y][x]; fg=color(c.fg,'#e4e6eb'); bg=color(c.bg,'#15171a')
            if c.reverse: fg,bg=bg,fg
            px,py=20+x*10,40+y*20
            d.rectangle((px,py,px+10,py+20), fill=bg)
            d.text((px,py),c.data,font=font,fill=fg,stroke_width=0)
    im.save(p.with_suffix('.png'))
    p.with_suffix('.txt').write_text('\n'.join(screen.display))
