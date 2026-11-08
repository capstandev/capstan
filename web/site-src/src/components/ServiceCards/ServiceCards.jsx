import presets from './presets'
import './ServiceCards.css'

/**
 * A row of compact service cards. Each is one link: hover (or keyboard
 * focus) lifts the card, eases its picture in, fills the call to action
 * with the card's own accent and turns its arrow toward the corner.
 *
 * The grid packs as many `minCardWidth` columns as fit, so it reflows from
 * three-up to a single column with no breakpoints; nothing depends on hover,
 * so touch gets every word and the button.
 */
export default function ServiceCards({
  items = [],
  preset = 'stone',
  theme,

  /* --- layout ------------------------------------------------------------ */
  minCardWidth = 260,
  gap = 12,
  /* Picture height over card width. */
  imageRatio = 0.75,
  radius = 2,
  padding = 18,

  /* --- motion ------------------------------------------------------------ */
  /* px the card rises, and how far the picture zooms. */
  lift = 3,
  zoom = 1.05,
  /* Seconds for every hover transition. */
  speed = 0.35,
  shadow = 1,

  className = '',
  style,
  ...rest
}) {
  const colours = { ...(presets[preset] || presets.stone), ...theme }
  const vars = {
    '--sc-min': `${minCardWidth}px`,
    '--sc-gap': `${gap}px`,
    '--sc-ratio': imageRatio,
    '--sc-radius': `${radius}px`,
    '--sc-pad': `${padding}px`,
    '--sc-lift': `${-lift}px`,
    '--sc-zoom': zoom,
    '--sc-speed': `${speed}s`,
    '--sc-shadow-k': shadow,
    '--sc-bg': colours.background,
    '--sc-card': colours.card,
    '--sc-title': colours.title,
    '--sc-text': colours.text,
    '--sc-muted': colours.muted,
    '--sc-tag': colours.tag,
    '--sc-cta-text': colours.ctaText,
    '--sc-badge': colours.badge,
    ...style,
  }

  return (
    <div className={`sc ${className}`.trim()} style={vars} {...rest}>
      <ul className="sc__grid">
        {items.map((it, i) => {
          const Tag = it.href ? 'a' : 'div'
          return (
            <li key={i} className="sc__item">
              <Tag
                className="sc__card"
                onClick={it.onClick}
                aria-controls={it.controls}
                aria-current={it.current}
                style={{ '--sc-accent': it.accent || colours.accent }}
                {...(it.href
                  ? { href: it.href, target: it.target, rel: it.target === '_blank' ? 'noopener noreferrer' : undefined }
                  : { tabIndex: 0 })}
              >
                <div className="sc__media">
                  {it.image && <img src={it.image} alt={it.alt ?? ''} decoding="async" draggable={false} />}
                  {it.hoverImage && <img className="sc__alt" src={it.hoverImage} alt="" decoding="async" draggable={false} />}
                  <span className="sc__badge">{it.number ?? String(i + 1).padStart(2, '0')}</span>
                </div>
                <div className="sc__body">
                  {it.category && (
                    <p className="sc__category">
                      <span className="sc__dot" aria-hidden="true" />
                      {it.category}
                    </p>
                  )}
                  {it.title && <h3 className="sc__title">{it.title}</h3>}
                  {it.description && <p className="sc__text">{it.description}</p>}
                  {it.tags?.length > 0 && (
                    <ul className="sc__tags">
                      {it.tags.map((t) => (
                        <li key={t}>{t}</li>
                      ))}
                    </ul>
                  )}
                  <div className="sc__foot">
                    {it.detail && <p className="sc__detail">{it.detail}</p>}
                    {it.cta && (
                      <span className="sc__cta">
                        {it.cta}
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M5 12h13M13 6l6 6-6 6" />
                        </svg>
                      </span>
                    )}
                  </div>
                </div>
              </Tag>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
