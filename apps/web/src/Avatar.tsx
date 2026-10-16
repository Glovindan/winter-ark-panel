const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');

const hue = (name: string) => [...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7);

export function Avatar({ name, url, size }: { name: string; url: string | null; size: number }) {
  const box = { width: size, height: size, fontSize: size * 0.38 };
  if (url) return <img className="avatar" style={box} src={url} alt="" referrerPolicy="no-referrer" />;
  return (
    <div className="avatar" style={{ ...box, background: `hsl(${hue(name)} 45% 85%)`, color: `hsl(${hue(name)} 45% 25%)` }}>
      {initials(name)}
    </div>
  );
}
