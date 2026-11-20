# Dispatch Weather

Browser app for Salt Lake City to Denver via I-80/I-25, Reno via I-80, and Las Vegas via I-15.

Opening the page requests a fresh NWS hourly forecast and raw wind-gust grid for each highway checkpoint. Enter departure time, average speed, and trailer configuration to recalculate weather during each segment's estimated passage. Medium rollover screening applies above 30 and below 50 mph. High applies at 50 mph or above. Both sustained wind and gusts are checked. Missing data is shown as incomplete. The app updates the displayed route per visitor. The original ArcGIS Online map item is linked separately.

The page includes wind charts, five hours of NOAA nowCOAST radar, and printable route reports. DOT coverage is partial. COtrip is queried when browser access permits, while official DOT links cover the other corridor states. Current closures, chain requirements, vehicle dimensions, and permits require verification on the agency sites. Forecast lower winds do not establish DOT reopening.

Host the root of the main branch with GitHub Pages. No build or secrets are required. Serve locally with `python -m http.server 8765` and open http://localhost:8765/.

Each visit defaults to departure now and 55 mph average speed. Adjust these for the planned trip. Use Refresh conditions to request another assessment while the page stays open.

Data sources include the National Weather Service API, NOAA nowCOAST, COtrip, and highway geometry from USDOT/FHWA NHS 2025 with the Cheyenne connector from BLM/WYDOT.
