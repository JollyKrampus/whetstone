import { useEffect, useRef, useState } from 'preact/hooks';
import { IMAGE_CREDIT, IMAGE_SIZES, cardImageUrl, hasBackImage, scryfallCardUrl } from '../lib/images.ts';
import { FORMAT_IDS, FORMAT_LABELS, type CardView } from '../worker/protocol.ts';
import ManaCost from './ManaCost.tsx';
import { usd } from './ui.tsx';

interface Props {
  card: CardView | null;
  onClose: () => void;
}

const RARITY_LABEL: Record<string, string> = { common: 'Common', uncommon: 'Uncommon', rare: 'Rare', mythic: 'Mythic' };

/** Formats a card can be played in (restricted ones say so) and formats that ban it, kept apart. */
export function legalityLines(legal: CardView['legal']): { legalIn: string[]; bannedIn: string[] } {
  return {
    legalIn: FORMAT_IDS.filter((f) => legal[f] === 'legal' || legal[f] === 'restricted').map((f) => `${FORMAT_LABELS[f]}${legal[f] === 'restricted' ? ' (restricted)' : ''}`),
    bannedIn: FORMAT_IDS.filter((f) => legal[f] === 'banned').map((f) => FORMAT_LABELS[f]),
  };
}

/**
 * Card details in a modal dialog (tap or click a card name; no hover needed). The image is
 * Scryfall's full card scan from cards.scryfall.io, loaded only when the dialog opens.
 */
export default function CardPeek({ card, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [face, setFace] = useState<'front' | 'back'>('front');
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (card) {
      setFace('front');
      setBroken(false);
      if (!d.open) d.showModal();
    } else if (d.open) d.close();
  }, [card]);

  if (!card) return <dialog ref={ref} class="peek" aria-label="Card details" onClose={onClose} />;
  const src = cardImageUrl(card.scryfallId, 'normal', face);
  const twoImages = hasBackImage(card.layout);
  const faces = card.faces.length > 0 ? card.faces : [{ name: card.name, manaCost: card.manaCost, typeLine: card.typeLine, oracleText: card.oracleText, ...(card.power !== undefined ? { power: card.power, toughness: card.toughness ?? '' } : {}) }];
  const { legalIn, bannedIn } = legalityLines(card.legal);

  return (
    <dialog
      ref={ref}
      class="peek"
      aria-labelledby="peek-title"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) ref.current?.close();
      }}
    >
      <div class="peek__inner">
        <header class="peek__head">
          <h2 id="peek-title" class="peek__title">
            {card.name}
          </h2>
          <button type="button" class="btn btn--ghost btn--icon peek__close" onClick={() => ref.current?.close()} aria-label="Close card details">
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </header>
        <div class="peek__body">
          {src && !broken ? (
            <figure class="peek__figure">
              <img
                class="peek__img"
                src={src}
                width={IMAGE_SIZES.normal.width}
                height={IMAGE_SIZES.normal.height}
                alt={`Card image of ${face === 'back' && card.faces[1] ? card.faces[1].name : (card.faces[0]?.name ?? card.name)}`}
                loading="eager"
                decoding="async"
                referrerpolicy="no-referrer"
                onError={() => setBroken(true)}
              />
              <figcaption class="peek__credit">
                {IMAGE_CREDIT}
                {twoImages ? (
                  <button type="button" class="btn btn--ghost peek__flip" onClick={() => setFace(face === 'front' ? 'back' : 'front')}>
                    Show {face === 'front' ? 'back' : 'front'} face
                  </button>
                ) : null}
              </figcaption>
            </figure>
          ) : (
            <p class="peek__noimg muted">{broken ? 'The card image could not be loaded.' : 'No image for this card.'}</p>
          )}
          <div class="peek__text">
            {faces.map((f, i) => (
              <section class="peek__face" key={i} aria-label={faces.length > 1 ? f.name : undefined}>
                {faces.length > 1 ? <h3 class="peek__facename">{f.name}</h3> : null}
                <p class="peek__line">
                  <span class="peek__type">{f.typeLine}</span>
                  {f.manaCost ? <ManaCost cost={f.manaCost} /> : null}
                </p>
                {f.oracleText ? (
                  <div class="peek__oracle">
                    {f.oracleText.split('\n').map((p, j) => (
                      <p key={j}>{p}</p>
                    ))}
                  </div>
                ) : (
                  <p class="peek__oracle muted">No rules text.</p>
                )}
                {f.power !== undefined ? (
                  <p class="peek__pt">
                    {f.power}/{f.toughness}
                  </p>
                ) : null}
              </section>
            ))}
            <dl class="peek__facts">
              <div>
                <dt>Wildcard</dt>
                <dd>
                  <span class={`gem gem--${card.rarity}`} aria-hidden="true" /> {RARITY_LABEL[card.rarity] ?? card.rarity}
                </dd>
              </div>
              <div>
                <dt>Legal in</dt>
                <dd>{legalIn.length > 0 ? legalIn.join(', ') : 'No Arena constructed format'}</dd>
              </div>
              {bannedIn.length > 0 ? (
                <div>
                  <dt>Banned in</dt>
                  <dd>{bannedIn.join(', ')}</dd>
                </div>
              ) : null}
              {card.priceUsd !== undefined ? (
                <div>
                  <dt>Paper price</dt>
                  <dd>about {usd(card.priceUsd)} (cheapest printing)</dd>
                </div>
              ) : null}
            </dl>
            <p>
              <a href={scryfallCardUrl(card.set, card.cn, card.name)} rel="noopener" target="_blank">
                View on Scryfall<span class="visually-hidden"> (opens in a new tab)</span>
              </a>
            </p>
          </div>
        </div>
      </div>
    </dialog>
  );
}

interface NameProps {
  card: CardView | undefined;
  /** Fallback text when the card record is unknown. */
  name: string;
  onOpen: (card: CardView) => void;
  class?: string;
}

/** A card name that opens its details. Plain text when the card is unknown. */
export function CardName({ card, name, onOpen, class: extra }: NameProps) {
  if (!card) return <span class={extra}>{name}</span>;
  return (
    <button type="button" class={extra ? `cardref ${extra}` : 'cardref'} aria-haspopup="dialog" onClick={() => onOpen(card)}>
      {name}
    </button>
  );
}
