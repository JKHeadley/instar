/**
 * mobile-pairing-word-code §3.1 — the fixed word list for WORD-NNNN pairing confirmation codes.
 * Exactly 256 uppercase A–Z words, 4–6 letters, no two within edit distance 1 of each other
 * (tests/unit/mobile-pairing-word-code.test.ts enforces every rule). Never reorder or edit in
 * place without re-running that test.
 */
export const PAIRING_WORDS: readonly string[] = Object.freeze([
  'ACORN', 'ALARM', 'ALBUM', 'ALPHA', 'AMBER', 'ANCHOR', 'ANGEL', 'ANKLE', 'APPLE', 'APRIL',
  'APRON', 'ARCH', 'ARROW', 'ASPEN', 'ATLAS', 'ATOM', 'AUTUMN', 'AVENUE', 'BADGE', 'BAGEL',
  'BAKER', 'BALLOT', 'BAMBOO', 'BANANA', 'BANJO', 'BARLEY', 'BARN', 'BASIL', 'BASKET', 'BEACH',
  'BEACON', 'BEAR', 'BEAVER', 'BELL', 'BERRY', 'BIRCH', 'BISON', 'BLADE', 'BLANK', 'BLOOM',
  'BOAT', 'BONUS', 'BOOK', 'BRANCH', 'BREAD', 'BRICK', 'BRIDGE', 'BRUSH', 'BUCKET', 'BUGLE',
  'BUNNY', 'BUTTON', 'CABIN', 'CACTUS', 'CAMEL', 'CAMERA', 'CANAL', 'CANDLE', 'CANOE', 'CANYON',
  'CARGO', 'CARPET', 'CASTLE', 'CEDAR', 'CELLO', 'CHAIR', 'CHALK', 'CHERRY', 'CHESS', 'CIDER',
  'CIRCUS', 'CITRUS', 'CLIFF', 'CLOCK', 'CLOUD', 'CLOVER', 'COBALT', 'COCOA', 'COMET', 'CORAL',
  'COTTON', 'COUCH', 'COYOTE', 'CRANE', 'CRAYON', 'CREEK', 'CROWN', 'CUBE', 'DAISY', 'DANCER',
  'DELTA', 'DESERT', 'DINNER', 'DONKEY', 'DRAGON', 'DRUM', 'EAGLE', 'EARTH', 'ELBOW', 'ENGINE',
  'FABRIC', 'FALCON', 'FARM', 'FENCE', 'FIDDLE', 'FIELD', 'FIGURE', 'FLAME', 'FLUTE', 'FOREST',
  'FOSSIL', 'FROST', 'GALAXY', 'GARDEN', 'GARLIC', 'GATE', 'GECKO', 'GEYSER', 'GIANT', 'GINGER',
  'GLOBE', 'GOOSE', 'GRAPE', 'GRAVEL', 'GUITAR', 'HAMMER', 'HARBOR', 'HARP', 'HAZEL', 'HELMET',
  'HERON', 'HONEY', 'HOOD', 'HORSE', 'IGLOO', 'INDIGO', 'ISLAND', 'IVORY', 'JACKET', 'JAGUAR',
  'JELLY', 'JIGSAW', 'JUNGLE', 'KAYAK', 'KETTLE', 'KITE', 'KIWI', 'KOALA', 'LADDER', 'LAGOON',
  'LAPTOP', 'LARK', 'LAUREL', 'LEMON', 'LENS', 'LETTER', 'LILAC', 'LIME', 'LINEN', 'LION',
  'LOCKET', 'LOTUS', 'MAGNET', 'MAPLE', 'MARBLE', 'MEADOW', 'MELON', 'METEOR', 'MINT', 'MIRROR',
  'MITTEN', 'MOSAIC', 'MOTH', 'MUFFIN', 'MUSEUM', 'NAPKIN', 'NECTAR', 'NEEDLE', 'NOODLE', 'NORTH',
  'NUTMEG', 'OASIS', 'OCEAN', 'OLIVE', 'ONION', 'ORANGE', 'ORBIT', 'ORCHID', 'OTTER', 'OYSTER',
  'PADDLE', 'PALACE', 'PANDA', 'PAPAYA', 'PARADE', 'PARROT', 'PASTA', 'PEANUT', 'PEARL', 'PEBBLE',
  'PENCIL', 'PEPPER', 'PIANO', 'PICKLE', 'PILOT', 'PIRATE', 'PIZZA', 'PLANET', 'PLUM', 'POLAR',
  'PONY', 'POPPY', 'PRISM', 'PUPPET', 'PUZZLE', 'QUARTZ', 'QUEEN', 'QUILL', 'RABBIT', 'RADAR',
  'RADIO', 'RAFT', 'RAVEN', 'RIBBON', 'RIVER', 'ROBIN', 'RUBY', 'SAFARI', 'SALMON', 'SANDAL',
  'SATURN', 'SCARF', 'SHADOW', 'SHELL', 'SILVER', 'SKETCH', 'SLED', 'SNAIL', 'SPIDER', 'SPRUCE',
  'SQUID', 'STAPLE', 'STONE', 'STREAM', 'SUMMER', 'SUNSET', 'SWAN', 'TABLE', 'TACO', 'TANGO',
  'TEAPOT', 'TENNIS', 'TIGER', 'TOAST', 'TOMATO', 'TOPAZ',
]);

/** O(1) membership for the leak scan (mobile-pairing-word-code §3.5). */
export const PAIRING_WORD_SET: ReadonlySet<string> = new Set(PAIRING_WORDS);
