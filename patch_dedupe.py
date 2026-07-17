with open('index.html', 'r') as f:
    c = f.read()

old = '''        <span class="hero-proof-item">Cold Read</span>
        <span class="hero-proof-item">Job Match search</span>
        <span class="hero-proof-item">Cold Read</span>
        <span class="hero-proof-item">Job Match search</span>'''

new = '''        <span class="hero-proof-item">Cold Read</span>
        <span class="hero-proof-item">Job Match search</span>'''

c = c.replace(old, new)

with open('index.html', 'w') as f:
    f.write(c)
print("done")
