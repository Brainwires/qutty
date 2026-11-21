/**
 * The quote of the day's pool (Settings → Companion → Quote of the day; lib/companion/ambient.ts
 * picks one per date). Public domain only: every author died long ago, and translated lines follow
 * old public-domain translations (George Long's Marcus Aurelius and Epictetus, Gummere's Seneca,
 * Legge's Confucius) or the common rendering of a few words. No song lyrics, no living or recently
 * dead authors, and no line whose attribution is disputed (no "Be the change…", no "Do not go where
 * the path may lead…", none of the sayings the internet hands to Twain, Lincoln or the Buddha).
 *
 * Append new quotes at the end: a quote's place in the list is what each date maps to, so
 * reordering would change past and future days.
 *
 * Client-safe data.
 *
 * @module
 */

/** One quote and who said or wrote it. */
export interface Quote {
  readonly text: string;
  readonly author: string;
}

const RAW: readonly (readonly [string, string])[] = [
  // Marcus Aurelius, Meditations (George Long's translation)
  [
    "Very little indeed is necessary for living a happy life.",
    "Marcus Aurelius",
  ],
  [
    "Such as are thy habitual thoughts, such also will be the character of thy mind; for the soul is dyed by the thoughts.",
    "Marcus Aurelius",
  ],
  [
    "No longer talk at all about the kind of man that a good man ought to be, but be such.",
    "Marcus Aurelius",
  ],
  [
    "The best way of avenging thyself is not to become like the wrong doer.",
    "Marcus Aurelius",
  ],
  [
    "Look within. Within is the fountain of good, and it will ever bubble up, if thou wilt ever dig.",
    "Marcus Aurelius",
  ],
  ["Loss is nothing else than change.", "Marcus Aurelius"],
  ["The universe is transformation: life is opinion.", "Marcus Aurelius"],
  ["Confine thyself to the present.", "Marcus Aurelius"],
  [
    "Adapt thyself to the things with which thy lot has been cast.",
    "Marcus Aurelius",
  ],
  [
    "Be like the promontory against which the waves continually break, but it stands firm and tames the fury of the water around it.",
    "Marcus Aurelius",
  ],
  [
    "Time is a sort of river of passing events, and strong is its current.",
    "Marcus Aurelius",
  ],
  // Seneca, Letters to Lucilius (Gummere's translation) and other works
  ["While we are postponing, life speeds by.", "Seneca"],
  ["Nothing, Lucilius, is ours, except time.", "Seneca"],
  ["We suffer more often in imagination than in reality.", "Seneca"],
  ["No man was ever wise by chance.", "Seneca"],
  [
    "Begin at once to live, and count each separate day as a separate life.",
    "Seneca",
  ],
  ["Associate with those who will make a better man of you.", "Seneca"],
  [
    "Wherever there is a human being, there is an opportunity for a kindness.",
    "Seneca",
  ],
  [
    "It is not that we have a short time to live, but that we waste a lot of it.",
    "Seneca",
  ],
  ["As long as you live, keep learning how to live.", "Seneca"],
  // Epictetus (George Long's translation)
  [
    "Men are disturbed not by the things which happen, but by the opinions about the things.",
    "Epictetus",
  ],
  [
    "No great thing is produced suddenly, since not even the grape or the fig is.",
    "Epictetus",
  ],
  [
    "First say to yourself what you would be; and then do what you have to do.",
    "Epictetus",
  ],
  ["If you would be a good reader, read; if a writer, write.", "Epictetus"],
  [
    "Make the best use of what is in your power, and take the rest as it happens.",
    "Epictetus",
  ],
  // Lao Tzu, Tao Te Ching (common renderings)
  ["A journey of a thousand miles begins with a single step.", "Lao Tzu"],
  [
    "He who knows others is wise; he who knows himself is enlightened.",
    "Lao Tzu",
  ],
  ["He who knows that enough is enough will always have enough.", "Lao Tzu"],
  [
    "The softest thing in the world dashes against and overcomes the hardest.",
    "Lao Tzu",
  ],
  [
    "Deal with the difficult while it is still easy; deal with the great while it is still small.",
    "Lao Tzu",
  ],
  // Confucius, the Analects (James Legge's translation)
  [
    "Is it not pleasant to learn with a constant perseverance and application?",
    "Confucius",
  ],
  [
    "When we see men of worth, we should think of equaling them; when we see men of a contrary character, we should turn inwards and examine ourselves.",
    "Confucius",
  ],
  ["What you do not want done to yourself, do not do to others.", "Confucius"],
  ["To see what is right and not to do it is want of courage.", "Confucius"],
  [
    "When you know a thing, to hold that you know it; and when you do not know a thing, to allow that you do not know it; this is knowledge.",
    "Confucius",
  ],
  [
    "Learning without thought is labour lost; thought without learning is perilous.",
    "Confucius",
  ],
  ["When you have faults, do not fear to abandon them.", "Confucius"],
  [
    "Virtue is not left to stand alone. He who practises it will have neighbours.",
    "Confucius",
  ],
  // Shakespeare
  ["This above all: to thine own self be true.", "William Shakespeare"],
  [
    "There is nothing either good or bad, but thinking makes it so.",
    "William Shakespeare",
  ],
  [
    "We know what we are, but know not what we may be.",
    "William Shakespeare",
  ],
  ["The readiness is all.", "William Shakespeare"],
  [
    "Our doubts are traitors, and make us lose the good we oft might win by fearing to attempt.",
    "William Shakespeare",
  ],
  [
    "The miserable have no other medicine but only hope.",
    "William Shakespeare",
  ],
  [
    "How far that little candle throws his beams! So shines a good deed in a naughty world.",
    "William Shakespeare",
  ],
  ["Sweet are the uses of adversity.", "William Shakespeare"],
  ["What's past is prologue.", "William Shakespeare"],
  [
    "We are such stuff as dreams are made on, and our little life is rounded with a sleep.",
    "William Shakespeare",
  ],
  ["Love all, trust a few, do wrong to none.", "William Shakespeare"],
  [
    "The fault, dear Brutus, is not in our stars, but in ourselves.",
    "William Shakespeare",
  ],
  ["Things won are done; joy's soul lies in the doing.", "William Shakespeare"],
  ["Wisely and slow; they stumble that run fast.", "William Shakespeare"],
  ["Though she be but little, she is fierce.", "William Shakespeare"],
  ["Brevity is the soul of wit.", "William Shakespeare"],
  ["Give every man thy ear, but few thy voice.", "William Shakespeare"],
  ["Be not afraid of greatness.", "William Shakespeare"],
  ["Men at some time are masters of their fates.", "William Shakespeare"],
  [
    "Better three hours too soon than a minute too late.",
    "William Shakespeare",
  ],
  [
    "How poor are they that have not patience! What wound did ever heal but by degrees?",
    "William Shakespeare",
  ],
  ["Modest doubt is call'd the beacon of the wise.", "William Shakespeare"],
  [
    "Have more than thou showest, speak less than thou knowest.",
    "William Shakespeare",
  ],
  [
    "Cowards die many times before their deaths; the valiant never taste of death but once.",
    "William Shakespeare",
  ],
  // Ralph Waldo Emerson
  [
    "Nothing great was ever achieved without enthusiasm.",
    "Ralph Waldo Emerson",
  ],
  [
    "Trust thyself: every heart vibrates to that iron string.",
    "Ralph Waldo Emerson",
  ],
  [
    "A foolish consistency is the hobgoblin of little minds.",
    "Ralph Waldo Emerson",
  ],
  ["Nothing can bring you peace but yourself.", "Ralph Waldo Emerson"],
  ["The only way to have a friend is to be one.", "Ralph Waldo Emerson"],
  ["Every artist was first an amateur.", "Ralph Waldo Emerson"],
  ["The years teach much which the days never know.", "Ralph Waldo Emerson"],
  ["Hitch your wagon to a star.", "Ralph Waldo Emerson"],
  ["The first wealth is health.", "Ralph Waldo Emerson"],
  [
    "Shallow men believe in luck. Strong men believe in cause and effect.",
    "Ralph Waldo Emerson",
  ],
  ["Insist on yourself; never imitate.", "Ralph Waldo Emerson"],
  ["The earth laughs in flowers.", "Ralph Waldo Emerson"],
  // Henry David Thoreau
  ["Simplify, simplify.", "Henry David Thoreau"],
  ["Our life is frittered away by detail.", "Henry David Thoreau"],
  [
    "I went to the woods because I wished to live deliberately.",
    "Henry David Thoreau",
  ],
  [
    "If you have built castles in the air, your work need not be lost; that is where they should be. Now put the foundations under them.",
    "Henry David Thoreau",
  ],
  [
    "If a man does not keep pace with his companions, perhaps it is because he hears a different drummer.",
    "Henry David Thoreau",
  ],
  [
    "As if you could kill time without injuring eternity.",
    "Henry David Thoreau",
  ],
  ["Only that day dawns to which we are awake.", "Henry David Thoreau"],
  [
    "Heaven is under our feet as well as over our heads.",
    "Henry David Thoreau",
  ],
  ["It is never too late to give up our prejudices.", "Henry David Thoreau"],
  [
    "Morning is when I am awake and there is a dawn in me.",
    "Henry David Thoreau",
  ],
  ["There is no remedy for love but to love more.", "Henry David Thoreau"],
  [
    "I never found the companion that was so companionable as solitude.",
    "Henry David Thoreau",
  ],
  ["Things do not change; we change.", "Henry David Thoreau"],
  [
    "However mean your life is, meet it and live it; do not shun it and call it hard names.",
    "Henry David Thoreau",
  ],
  ["Love your life, poor as it is.", "Henry David Thoreau"],
  ["What is once well done is done forever.", "Henry David Thoreau"],
  // Benjamin Franklin (most from Poor Richard's Almanack)
  ["Well done is better than well said.", "Benjamin Franklin"],
  [
    "Early to bed and early to rise, makes a man healthy, wealthy, and wise.",
    "Benjamin Franklin",
  ],
  ["Lost time is never found again.", "Benjamin Franklin"],
  ["Little strokes fell great oaks.", "Benjamin Franklin"],
  ["Haste makes waste.", "Benjamin Franklin"],
  ["An ounce of prevention is worth a pound of cure.", "Benjamin Franklin"],
  ["Diligence is the mother of good luck.", "Benjamin Franklin"],
  ["He that can have patience can have what he will.", "Benjamin Franklin"],
  [
    "Never leave that till tomorrow which you can do today.",
    "Benjamin Franklin",
  ],
  [
    "Dost thou love life? Then do not squander time, for that's the stuff life is made of.",
    "Benjamin Franklin",
  ],
  [
    "Hide not your talents, they for use were made. What's a sundial in the shade?",
    "Benjamin Franklin",
  ],
  [
    "Be at war with your vices, at peace with your neighbours, and let every new year find you a better man.",
    "Benjamin Franklin",
  ],
  [
    "Content makes poor men rich; discontent makes rich men poor.",
    "Benjamin Franklin",
  ],
  ["A small leak will sink a great ship.", "Benjamin Franklin"],
  ["The doors of wisdom are never shut.", "Benjamin Franklin"],
  // Abraham Lincoln
  ["With malice toward none, with charity for all.", "Abraham Lincoln"],
  ["Let us have faith that right makes might.", "Abraham Lincoln"],
  [
    "The dogmas of the quiet past are inadequate to the stormy present.",
    "Abraham Lincoln",
  ],
  [
    "Always bear in mind that your own resolution to succeed is more important than any other one thing.",
    "Abraham Lincoln",
  ],
  // Mark Twain
  [
    "Courage is resistance to fear, mastery of fear, not absence of fear.",
    "Mark Twain",
  ],
  [
    "Always do right. This will gratify some people and astonish the rest.",
    "Mark Twain",
  ],
  [
    "Let us endeavor so to live that when we come to die even the undertaker will be sorry.",
    "Mark Twain",
  ],
  [
    "Habit is habit, and not to be flung out of the window by any man, but coaxed down-stairs a step at a time.",
    "Mark Twain",
  ],
  ["Wrinkles should merely indicate where smiles have been.", "Mark Twain"],
  ["Against the assault of laughter nothing can stand.", "Mark Twain"],
  [
    "Never put off till to-morrow what may be done day after to-morrow just as well.",
    "Mark Twain",
  ],
  [
    "Truth is stranger than fiction, but it is because Fiction is obliged to stick to possibilities; Truth isn't.",
    "Mark Twain",
  ],
  // Jane Austen
  ["There is no charm equal to tenderness of heart.", "Jane Austen"],
  ["I declare after all there is no enjoyment like reading!", "Jane Austen"],
  [
    "Know your own happiness. You want nothing but patience; or give it a more fascinating name, call it hope.",
    "Jane Austen",
  ],
  [
    "My courage always rises at every attempt to intimidate me.",
    "Jane Austen",
  ],
  [
    "Think only of the past as its remembrance gives you pleasure.",
    "Jane Austen",
  ],
  [
    "Friendship is certainly the finest balm for the pangs of disappointed love.",
    "Jane Austen",
  ],
  [
    "We have all a better guide in ourselves, if we would attend to it, than any other person can be.",
    "Jane Austen",
  ],
  // Walt Whitman
  ["I am large, I contain multitudes.", "Walt Whitman"],
  ["I exist as I am, that is enough.", "Walt Whitman"],
  ["Afoot and light-hearted I take to the open road.", "Walt Whitman"],
  [
    "To me every hour of the light and dark is a miracle.",
    "Walt Whitman",
  ],
  ["I celebrate myself, and sing myself.", "Walt Whitman"],
  [
    "Re-examine all you have been told, dismiss whatever insults your own soul.",
    "Walt Whitman",
  ],
  ["Resist much, obey little.", "Walt Whitman"],
  // Emily Dickinson
  [
    "“Hope” is the thing with feathers, that perches in the soul.",
    "Emily Dickinson",
  ],
  ["Forever is composed of Nows.", "Emily Dickinson"],
  ["I dwell in Possibility, a fairer House than Prose.", "Emily Dickinson"],
  [
    "If I can stop one heart from breaking, I shall not live in vain.",
    "Emily Dickinson",
  ],
  ["The Brain is wider than the Sky.", "Emily Dickinson"],
  [
    "That it will never come again is what makes life so sweet.",
    "Emily Dickinson",
  ],
  ["Tell all the truth but tell it slant.", "Emily Dickinson"],
  [
    "To live is so startling it leaves little time for anything else.",
    "Emily Dickinson",
  ],
  [
    "Not knowing when the Dawn will come, I open every Door.",
    "Emily Dickinson",
  ],
  // Classical
  ["The unexamined life is not worth living.", "Socrates"],
  ["One swallow does not make a summer, nor does one day.", "Aristotle"],
  ["Life is short, the art long, opportunity fleeting.", "Hippocrates"],
  ["Carpe diem.", "Horace"],
  [
    "He who has begun has half done. Dare to be wise; begin!",
    "Horace",
  ],
  ["They can because they think they can.", "Virgil"],
  [
    "Be patient and tough; some day this pain will be useful to you.",
    "Ovid",
  ],
  ["Anyone can hold the helm when the sea is calm.", "Publilius Syrus"],
  ["Practice is the best of all instructors.", "Publilius Syrus"],
  [
    "If you have a garden and a library, you have everything you need.",
    "Cicero",
  ],
  [
    "Gratitude is not only the greatest of virtues, but the parent of all the others.",
    "Cicero",
  ],
  ["Slow and steady wins the race.", "Aesop"],
  ["No act of kindness, no matter how small, is ever wasted.", "Aesop"],
  // Poets
  ["To err is human; to forgive, divine.", "Alexander Pope"],
  ["Hope springs eternal in the human breast.", "Alexander Pope"],
  [
    "The mind is its own place, and in itself can make a Heaven of Hell, a Hell of Heaven.",
    "John Milton",
  ],
  ["They also serve who only stand and wait.", "John Milton"],
  ["A thing of beauty is a joy for ever.", "John Keats"],
  [
    "Nothing ever becomes real till it is experienced.",
    "John Keats",
  ],
  ["The Child is father of the Man.", "William Wordsworth"],
  [
    "Fill your paper with the breathings of your heart.",
    "William Wordsworth",
  ],
  ["If Winter comes, can Spring be far behind?", "Percy Bysshe Shelley"],
  ["To strive, to seek, to find, and not to yield.", "Alfred, Lord Tennyson"],
  [
    "'Tis better to have loved and lost than never to have loved at all.",
    "Alfred, Lord Tennyson",
  ],
  [
    "Ah, but a man's reach should exceed his grasp, or what's a heaven for?",
    "Robert Browning",
  ],
  ["Grow old along with me! The best is yet to be.", "Robert Browning"],
  [
    "Lives of great men all remind us we can make our lives sublime.",
    "Henry Wadsworth Longfellow",
  ],
  [
    "Into each life some rain must fall, some days must be dark and dreary.",
    "Henry Wadsworth Longfellow",
  ],
  [
    "Let us, then, be up and doing, with a heart for any fate.",
    "Henry Wadsworth Longfellow",
  ],
  [
    "The heights by great men reached and kept were not attained by sudden flight, but they, while their companions slept, were toiling upward in the night.",
    "Henry Wadsworth Longfellow",
  ],
  [
    "To see a World in a Grain of Sand, and a Heaven in a Wild Flower.",
    "William Blake",
  ],
  ["Great things are done when men and mountains meet.", "William Blake"],
  [
    "The best laid schemes o' mice an' men gang aft agley.",
    "Robert Burns",
  ],
  ["No man is an island, entire of itself.", "John Donne"],
  [
    "If you can keep your head when all about you are losing theirs…",
    "Rudyard Kipling",
  ],
  [
    "I am the master of my fate, I am the captain of my soul.",
    "William Ernest Henley",
  ],
  ["Say not the struggle nought availeth.", "Arthur Hugh Clough"],
  [
    "Laugh, and the world laughs with you; weep, and you weep alone.",
    "Ella Wheeler Wilcox",
  ],
  // Novelists and essayists
  [
    "To travel hopefully is a better thing than to arrive.",
    "Robert Louis Stevenson",
  ],
  [
    "The world is so full of a number of things, I'm sure we should all be as happy as kings.",
    "Robert Louis Stevenson",
  ],
  [
    "No one is useless in this world who lightens the burden of it to any one else.",
    "Charles Dickens",
  ],
  [
    "Have a heart that never hardens, and a temper that never tires, and a touch that never hurts.",
    "Charles Dickens",
  ],
  [
    "I'm not afraid of storms, for I'm learning how to sail my ship.",
    "Louisa May Alcott",
  ],
  ["I am no bird; and no net ensnares me.", "Charlotte Brontë"],
  [
    "What do we live for, if it is not to make life less difficult to each other?",
    "George Eliot",
  ],
  [
    "Why, sometimes I've believed as many as six impossible things before breakfast.",
    "Lewis Carroll",
  ],
  [
    "Begin at the beginning, and go on till you come to the end: then stop.",
    "Lewis Carroll",
  ],
  [
    "We are all in the gutter, but some of us are looking at the stars.",
    "Oscar Wilde",
  ],
  [
    "To love oneself is the beginning of a lifelong romance.",
    "Oscar Wilde",
  ],
  ["Experience is the name every one gives to their mistakes.", "Oscar Wilde"],
  [
    "It is better to fail in originality than to succeed in imitation.",
    "Herman Melville",
  ],
  [
    "Beware; for I am fearless, and therefore powerful.",
    "Mary Shelley",
  ],
  [
    "Great works are performed not by strength but by perseverance.",
    "Samuel Johnson",
  ],
  ["Few things are impossible to diligence and skill.", "Samuel Johnson"],
  ["A wise man will make more opportunities than he finds.", "Francis Bacon"],
  ["May you live all the days of your life.", "Jonathan Swift"],
  ["There is no wealth but life.", "John Ruskin"],
  [
    "Have nothing in your houses that you do not know to be useful, or believe to be beautiful.",
    "William Morris",
  ],
  [
    "Never give up then, for that is just the place and time that the tide will turn.",
    "Harriet Beecher Stowe",
  ],
  [
    "Just living is not enough. One must have sunshine, freedom, and a little flower.",
    "Hans Christian Andersen",
  ],
  // Thinkers and scientists
  [
    "If I have seen further it is by standing on the shoulders of Giants.",
    "Isaac Newton",
  ],
  [
    "A man who dares to waste one hour of time has not discovered the value of life.",
    "Charles Darwin",
  ],
  [
    "Life can only be understood backwards; but it must be lived forwards.",
    "Søren Kierkegaard",
  ],
  ["The perfect is the enemy of the good.", "Voltaire"],
  ["We must cultivate our garden.", "Voltaire"],
  [
    "I have made this longer than usual because I have not had time to make it shorter.",
    "Blaise Pascal",
  ],
  ["Knowing is not enough; we must apply.", "Johann Wolfgang von Goethe"],
  [
    "In every walk with nature one receives far more than he seeks.",
    "John Muir",
  ],
  ["The mountains are calling and I must go.", "John Muir"],
  // Statesmen and reformers
  ["The harder the conflict, the more glorious the triumph.", "Thomas Paine"],
  ["I cannot live without books.", "Thomas Jefferson"],
  ["If there is no struggle, there is no progress.", "Frederick Douglass"],
  [
    "Learning is not attained by chance, it must be sought for with ardor and attended to with diligence.",
    "Abigail Adams",
  ],
  ["The secret of success is constancy to purpose.", "Benjamin Disraeli"],
  [
    "Success is to be measured not so much by the position that one has reached in life as by the obstacles which he has overcome.",
    "Booker T. Washington",
  ],
  [
    "Far better is it to dare mighty things, to win glorious triumphs, even though checkered by failure.",
    "Theodore Roosevelt",
  ],
  [
    "It is the greatest of all mistakes to do nothing because you can only do little.",
    "Sydney Smith",
  ],
];

/** Every quote, in their fixed order. */
export const QUOTES: readonly Quote[] = RAW.map(([text, author]) => ({
  text,
  author,
}));
