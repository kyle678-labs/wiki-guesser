"use strict";

// "Party mix": guessable 1–2 word topics whose Wikipedia page has a good image.
const TOPICS = [
  // animals
  "Polar bear","Giraffe","Octopus","Platypus","Hedgehog","Flamingo","Axolotl","Sloth","Narwhal","Chameleon",
  "Peacock","Tarantula","Komodo dragon","Mantis shrimp","Capybara","Wolverine","Anteater","Pufferfish","Toucan","Meerkat",
  "Bald eagle","Great white shark","Snow leopard","Red panda","Blue whale","Honey badger","Sea otter","Jellyfish","Armadillo","Ostrich",
  // food & drink
  "Sushi","Croissant","Tacos","Ramen","Pretzel","Guacamole","Tiramisu","Kimchi","Waffle","Burrito",
  "Hot dog","Onion ring","Pancake","Bubble tea","Espresso","Poutine","Baguette","Churro","Meatball","Lasagna",
  "Dragon fruit","Pomegranate","Artichoke","Wasabi","Maple syrup","Cotton candy","Fortune cookie","Gingerbread","Milkshake","Nachos",
  // places & landmarks
  "Eiffel Tower","Stonehenge","Mount Everest","Grand Canyon","Niagara Falls","Taj Mahal","Machu Picchu","Great Sphinx","Big Ben","Colosseum",
  "Golden Gate Bridge","Mount Rushmore","Venice","Santorini","Sahara","Antarctica","Las Vegas","Tokyo","Dubai","Iceland",
  "Times Square","Loch Ness","Pompeii","Yellowstone","Alcatraz","Chernobyl","Bermuda Triangle","Area 51","Atlantis","Hollywood Sign",
  // things & concepts
  "Lava lamp","Rubik's Cube","Disco ball","Hot air balloon","Ferris wheel","Roller coaster","Vending machine","Fire hydrant","Windmill","Lighthouse",
  "Submarine","Jetpack","Chainsaw","Boomerang","Kazoo","Accordion","Bagpipes","Typewriter","Gramophone","Metronome",
  "Snow globe","Piñata","Whoopee cushion","Slinky","Yo-yo","Pogo stick","Trampoline","Hammock","Kayak","Segway",
  "Traffic cone","Porta-potty","Mullet","Fanny pack","Crocs","Karaoke","Foosball","Beer pong","Duct tape","Bubble wrap",
  // nature & science
  "Aurora borealis","Tornado","Tsunami","Quicksand","Geyser","Volcano","Black hole","Solar eclipse","Meteor shower","Lightning",
  "Venus flytrap","Cactus","Bonsai","Redwood","Tumbleweed","Coral reef","Iceberg","Sand dune","Rainbow","Fog",
  // people & characters
  "Albert Einstein","Elvis Presley","Marilyn Monroe","Bob Ross","Mr. Bean","Shrek","Godzilla","Bigfoot","Dracula","Frankenstein",
  "Santa Claus","Tooth fairy","Medusa","Zeus","Cleopatra","Napoleon","Abraham Lincoln","William Shakespeare","Mona Lisa","Michael Jackson",
  "Freddie Mercury","Dolly Parton","Snoop Dogg","Danny DeVito","Keanu Reeves","The Rock","Mr. T","Chuck Norris","Betty White","Weird Al",
  // misc fun
  "Zamboni","Blimp","Monster truck","Ice sculpture","Sock puppet","Garden gnome","Scarecrow","Jack-o'-lantern","Mistletoe","Confetti",
  "Limbo","Conga line","Mosh pit","Air guitar","Belly flop","Cannonball","Slip 'N Slide","Water balloon","Silly String","Glow stick",
];

module.exports = { TOPICS };
