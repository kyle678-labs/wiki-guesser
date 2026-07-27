/* Privacy / terms pages: just the theme toggle. These pages deliberately load no
   config and open no socket — reading a privacy policy shouldn't create a
   session, which would be a poor look for the privacy policy in particular. */
WG.initTheme();
