---
kind: "link"
url: "https://news.ycombinator.com/item?id=19804478"
captured: "2026-10-25T16:48"
via: "share"
title: "Local-first software: You own your data, in spite of the cloud | Hacker News"
enriched: "2026-10-25T16:48"
---



<!-- kintsugi:source -->
## Source

|   |   |   |
| - | - | - |
| ![](https://news.ycombinator.com/s.gif) |  | <br>I've been thinking on and off about this problem space for about a decade now - having worked on google wave, ShareJS and ShareDB. The architecture I want is something like this:<br>- My data is stored at a well known URL on a machine that I own. If people don't want to host their own stuff, they can rent another person's computer.<br>- We need a standard protocol for "data that changes over time". This is a really obvious point once you start thinking about it - REST doesn't support realtime edits, and websockets / zmq / etc are all too low level. We need a standard way to express semantic changes (eg CRDT edits) and do catchup, that can work across multiple devices / applications / underlying protocols. I've been working on this as part of statecraft - [https://github.com/josephg/statecraft](https://github.com/josephg/statecraft) but its still hidden behind all the documentation I haven't written yet.<br>- Then we need application-specific schemas to be published. Eg, there should be a standard calendar schema with events / reminders / whatever. Any calendar vendor could provide this. Then calendar apps could request on login from the user where the calendar data actually lives. Those apps could be web / mobile / desktop / whatever, because remember - we have a standard way to interoperate with data like this.<br>- Ideally the data would also be stored encrypted at rest. The server shouldn't need to be able to read any of the user's data.<br>You could build a peer to peer system whereby my desktop apps and phone share data with one another. But ideally, data should be accessible from any device at any time without worrying about whether your laptop is on or off. For that we need servers. You could make a single persistent server be a peer in a CRDT-based cluster of devices. That might be better - but its harder to implement and might run into issues with bandwidth and size (I don't want my phone to sync my whole photo library, etc). There are some generally unsolved problems here, but I don't think they're beyond us.<br>If you're working on this problem and want to chat, throw me an email - I'm me@josephg.com. |

|   |   |   |
| - | - | - |
| ![](https://news.ycombinator.com/s.gif) |  | <br>I feel the dat project ([https://datproject.org/](https://datproject.org/)) ticks some boxes you want as a base protocol. Dat itself is an easy-to-use tool for syncing large files between machines, but its core ([http://awesome.datproject.org/hypercore](http://awesome.datproject.org/hypercore)) gives you everything you need to build on top of.<br>With dat you have: - urls to individual files, with the understanding that they will change over time - built-in encryption and non-repudiability of every change - storage wherever you want, no peer is more important than any other |

|   |   |   |
| - | - | - |
| ![](https://news.ycombinator.com/s.gif) |  | <br>The Dat protocol is remarkably complex. \[1\]<br>Shared object updates should be deliverable by any protocol that works for a specific application, whether client/server, peer-to-peer, or store-and-forward.<br>\[1\] [https://datprotocol.github.io/how-dat-works/](https://datprotocol.github.io/how-dat-works/) |

|   |   |   |
| - | - | - |
| ![](https://news.ycombinator.com/s.gif) |  | <br>It is complex if you compare it to, say, a simple cp to another system, but for all the features it has (and don't feel optional at this point) it is remarkably easy to grasp. The BitTorrent protocol is extremely straightforward, and dat clearly takes inspiration from it and build on top of it. Perhaps I'm to use to it and see the increment as too small, though. |

|   |   |   |
| - | - | - |
| ![](https://news.ycombinator.com/s.gif) |  | <br>It is, but the internals of any filesystem or database will be complex. That doesn't make them difficult to use. |

|   |   |   |
| - | - | - |
| ![](https://news.ycombinator.com/s.gif) |  |  |

|   |   |   |
| - | - | - |
| ![](https://news.ycombinator.com/s.gif) |  | <br>At least the calendar aspect of this has existed for over a decade. Similarly there are standardized protocols for handing sever-based contact lists and email and chats. Sure most of those protocols are crappy but you’ll just use a library anyway so that’s not an excuse. The problem is not on the technical side. Basically all the big providers have decided a walled garden is the best long term strategy and have been dropping support for any standards-compliant data sharing.<br>14 years ago I was syncing my contact lists from my personal server to a flip phone over vCard format (I think? Don’t remember exactly, but the contacts equivalent of CalDAV). Nowadays you either need to oAuth into Google or whatever other centralized provider a user might have, with whichever proprietary API they may or may not give you access to.<br>As with so many other things, a shiny new technical solution won’t change the reality that big companies are not incentivized to support interoperability. |

|   |   |   |
| - | - | - |
| ![](https://news.ycombinator.com/s.gif) |  | <br>Apple support for CalDAV and CardDAV is in a good shape. The sync mechanism isn’t as good as the native integration with iCloud, but I see it’s related to the protocol. |

|   |   |   |
| - | - | - |
| ![](https://news.ycombinator.com/s.gif) |  | <br>I'm not sure about the CDRT part, but otherwise I think Tim Berners-Lee's new SOLID project ticks those boxes? [https://solid.inrupt.com/](https://solid.inrupt.com/)<br>(Except the encryption, I think.) |

|   |   |   |
| - | - | - |
| ![](https://news.ycombinator.com/s.gif) |  | <br>I really get the motivation. And id pay both convenience and money. But whats the business model, or why would the existing user data silo megacorps ever want to interoperate? Or is it just a new old third way of self hosting for the motivated minority? |

|   |   |   |
| - | - | - |
| ![](https://news.ycombinator.com/s.gif) |  | <br>If it's easy enough and faced with the ever-growing concern with surveillance and dark patterns, it might not only be the minority that is motivated. |

|   |   |   |
| - | - | - |
| ![](https://news.ycombinator.com/s.gif) |  | <br>*\> We need a standard protocol for "data that changes over time".*<br>This already exists: it's called a DVCS. |

|   |   |   |
| - | - | - |
| ![](https://news.ycombinator.com/s.gif) |  | <br>DVCS focus exclusively on files rather than JSON (or whatever). They’re diff-based rather than operation based. They aren’t designed to work in a real-time manner. They require humans to fix merge conflicts. (Even many trivial ones). They store every change for all time (and require that you do so by design). And commits are a heavyweight operation. If you made a git commit for every keystroke, git would struggle. Also the network protocols aren’t published, and usually aren’t designed to work over websockets / etc for web apps.<br>We need something like a dvcs, but not exactly that. |

|   |   |   |
| - | - | - |
| ![](https://news.ycombinator.com/s.gif) |  | <br>I use Syncthing¹ for years now, mainly to sync the notes I write on my phone to my laptop and vice versa, but also as a way to sync my photos to my PC. Or as a way to sync my keepass password safe to other locations.<br>It only really works when two of the sharing machines are online at the same time. I work around this by having a rasperry pi running 24/7 which does it's thing.<br>I always tried to avoid cloud based services, because I don't want to keep thinking about whether I can trust cloud providers and I kinda like the idea of a LAN beeing used for LAN things – you know.. *local* stuff.<br>¹: [https://syncthing.net/](https://syncthing.net/) |

|   |   |   |
| - | - | - |
| ![](https://news.ycombinator.com/s.gif) |  | <br>Does Syncthing work reliably for you? I've been unable to make it work.<br>I've set it up to backup folders from my phone to a LAN storage drive (running it as a service on Windows, with the storage connected as a network drive), but it seems to "forget" the connection between the server and the phone. It says the folders are up to date, and won't pull the most recent files and photos from the phone. |

|   |   |   |
| - | - | - |
| ![](https://news.ycombinator.com/s.gif) |  | <br>I had problems on android too. if I recall right, it had to do with power saving/background connections. Somwhere in the android app settings you can allow syncthing to run in background or so, then it works |

|   |   |   |
| - | - | - |
| ![](https://news.ycombinator.com/s.gif) |  | <br>Yes, I allowed background running in the power saving settings - this helps in the short term.<br>But the problem seems to be in the server; after restarting the computer or the phone, the connection between folders seems to be lost - it doesn't "see" the remote folder anymore, even if its ID has not changed.<br>To be fair, this doesn't happen with Syncthing only. Other tools like Nitroshare or Dukto are also hit or miss when trying to connect from the phone. |

|   |   |   |
| - | - | - |
| ![](https://news.ycombinator.com/s.gif) |  | <br>Okay, weird. I didn't have such a problem up to now. |

|   |   |   |
| - | - | - |
| ![](https://news.ycombinator.com/s.gif) |  | <br>I’d love to try that, but unfortunately iOS hates open source software and it seems nobody has made a working app for iPhone yet... |

|   |   |   |
| - | - | - |
| ![](https://news.ycombinator.com/s.gif) |  | <br>Lack of SyncThing is my greatest pain point after having switched from Android to iOS. |

|   |   |   |
| - | - | - |
| ![](https://news.ycombinator.com/s.gif) |  | <br>This has been a dream of mine for so long, it is great to see excitement and serious thought for it.<br>One hack to give this a try would be to play around with integrating APIs for cloud storage to go through a local cache system first, then do async synchronisation on demand. (Collaboration is not really enabled here but the rest of the principles in [https://www.inkandswitch.com/local-first.html#practitioners](https://www.inkandswitch.com/local-first.html#practitioners) become trivial). Essentially firebase but with developer facing API bridges, for dropbox, drive, Amazon, ftp, whatever. The twist: you have more control of the data and it doesn't necessarily go up to Firebase backend, the devices could even do the backend computations async. Then you can build on top of any cloud storage platform, even decentralize things. It gets even more exciting to think of decentralization.<br>I would like to additionally emphasize on the case for data being on the cloud where it is not necessary to be there. Location history comes to mind. I want it to be local-first, local-only. |

|   |   |   |
| - | - | - |
| ![](https://news.ycombinator.com/s.gif) |  |  |

|   |   |   |
| - | - | - |
| ![](https://news.ycombinator.com/s.gif) |  | <br>Thanks for sharing! |

|   |   |   |
| - | - | - |
| ![](https://news.ycombinator.com/s.gif) |  | <br>I was hoping to read more about how merging of conflicts are done. The article tells us, that "users have an intuitive sense of human collaboration and avoid creating conflicts with their collaborators". Regarding non-clear merging, it states that it's still an open research question of how to let the application or the user with a view of the change history merge the conflicts.<br>How to merge conflicts is probably the most important part in a non-trivial app. Does anyone know of examples or research that has been done in this direction? |

|   |   |   |
| - | - | - |
| ![](https://news.ycombinator.com/s.gif) |  | <br>I think the simplest strategy is to create "conflict documents" containing all conflicted data and present to the user for manual resolution.<br>This seems similar to what Evernote does |

|   |   |   |
| - | - | - |
| ![](https://news.ycombinator.com/s.gif) |  |  |

|   |   |   |
| - | - | - |
| ![](https://news.ycombinator.com/s.gif) |  | <br>I thought a lot about this type of application when Dapps (decentralized applications) became a thing with ethereum. I tried to build one that is really decentralized and also works on multiple platforms.<br>Opposite to the analysis of this article, I have chosen a webapp that runs in the browser.<br>The App itself is just a mhtml-file that includes javascript, css and images. See [https://en.wikipedia.org/wiki/MHTML](https://en.wikipedia.org/wiki/MHTML)<br>Users can send it around as they want and do not have to install anything. Also the app makes a call to a server which makes recommendations on updates.<br>For the data-storage, I had some trouble because there was no database out there which supported replication, json-import/export and encryption. That was the reason I created one. [https://github.com/pubkey/rxdb](https://github.com/pubkey/rxdb) |

|   |   |   |
| - | - | - |
| ![](https://news.ycombinator.com/s.gif) |  | <br>Did you look at PouchDB for data storage? It's designed for replication, has built-in JSON import and export, and their are encryption plugins. |

|   |   |   |
| - | - | - |
| ![](https://news.ycombinator.com/s.gif) |  | <br>RxDB is based on pouchdb |

|   |   |   |
| - | - | - |
| ![](https://news.ycombinator.com/s.gif) |  | <br>Looks cool! |

|   |   |   |
| - | - | - |
| ![](https://news.ycombinator.com/s.gif) |  | <br>I've been working on software that meets at least most of the objectives this outlines, and for the same reasons.<br>The concept was blown off by my "Group Mentor" in Startup School last October, which was a bit disappointing, but it's good to see it being discussed here and maybe it will get some legs as time goes on.<br>I'll be releasing a simple app soon that, hopefully, demonstrates the advantages in a way that's easy to digest. At this point I'm not expecting much positive feedback though. It doesn't use any of the current trendy tech and there's nothing truly new or whizbanging about it. It is, however, fast, solid, easy to develop and modify, and runs on any server without having to install anything other than a web server. |

|   |   |   |
| - | - | - |
| ![](https://news.ycombinator.com/s.gif) |  | <br>This is brave to post here. The web is based on taking control away, and many businesses are based on that. Here we are at a place of investors in businesses. |

|   |   |   |
| - | - | - |
| ![](https://news.ycombinator.com/s.gif) |  | <br>In my spare time I've been working on something I currently call Distos (Distributed Operating System).<br>My goal is to create a sort of log database merged with an app platform which maintains an encrypted and authenticated log structure that powers functions in developer code that update/manipulate local stateful resources. The apps on a user's device get access to resources managed by the platform like KV stores or Sqlite databases. The App uses these log messages, which are filtered and provided by the platform, to update these stores locally and creates new logs on the user facing clients in order to make things happen both locally and remotely once the logs are synced.<br>I am convinced that "logs" are the future for personal data. |

|   |   |   |
| - | - | - |
| ![](https://news.ycombinator.com/s.gif) |  |  |

|   |   |   |
| - | - | - |
| ![](https://news.ycombinator.com/s.gif) |  | <br>Yes Scuttlebutt is a big inspiration among others. I believe the primary change/improvement I'm making is that it runs on the device and is also focused on the user's data instead running on a server or doing distributed social networking.<br>Reading \[1\] makes it seem to me like I might just be reinventing Lotus Notes. |

|   |   |   |
| - | - | - |
| ![](https://news.ycombinator.com/s.gif) |  |  |

|   |   |   |
| - | - | - |
| ![](https://news.ycombinator.com/s.gif) |  | <br>If I had to bet on personal computers' and other devices' future, I would say that some years down the line--not many--only a barebones system will run on them so they can connect to an OS delivered through a cloud service. The turning point will be Google Stadia's success.<br>As much as I would prefer local-first as well as offline-first approaches, I reckon that the future will only have a place on the fringes for them. |

|   |   |   |
| - | - | - |
| ![](https://news.ycombinator.com/s.gif) |  | <br>The problem is to achieve acceptable quality of service for an online cloud OS service with all the responsive UIs and expected reliability, everything has to be done locally-first either way, using approaches like CRDTs. And even more so for Google, because their level of service quality delivered over public internet is nowhere near acceptable for an OS and will never be. But, of course, they can still offer locally-first OS as a service, not giving users any control. |

|   |   |   |
| - | - | - |
| ![](https://news.ycombinator.com/s.gif) |  | <br>I’ve worked in the industry of SaaS vs. Enterprise long enough to see Google Cloud (with all its compute power) get turned down because it requires the corporation to share its data. |

|   |   |   |
| - | - | - |
| ![](https://news.ycombinator.com/s.gif) |  | <br>In my experience, most customers end up trusting at least one cloud vendor. If not GCP (which does not have regions in France for example), they will trust Azure or AWS (who do). If they are a big e-commerce company, they will hate AWS but go to Azure, etc.<br>The reason is mostly the human cost of maintaining infrastructure, and the global lack of good people have the knowledge to do so.<br>Edit: Trusting hundreds of SaaS vendors vs. one major cloud platform is another debate though. |

|   |   |   |
| - | - | - |
| ![](https://news.ycombinator.com/s.gif) |  | <br>Not in the financial industry AFAIK.<br>Saving costs is a major drive, I agree... |

|   |   |   |
| - | - | - |
| ![](https://news.ycombinator.com/s.gif) |  | <br>For latency it depends, having a fiber connection to a data center in a nearby city gives 0-2ms latency. Using WiFi adds about 50-100ms. Keyboard-to-computer 10-20ms, computer-to-screen 10-20 ms, software rendering 0-2 ms. So if you have a good Internet connection (and not using wifi) you wouldn't really notice if the "app" was running on your computer or on a server. Try for example ssh -X and start a GUI app/game on a server. The history tend to repeat itself, maybe in a few years we will mostly be using realy lightweight mobile devices connected to a powerful server in some noisy data-center. I do have a hate and love relationship with hardware though, running your own computer is one order of magnitude cheaper then running one in the cloud. So server hosting prices need to go down. |

|   |   |   |
| - | - | - |
| ![](https://news.ycombinator.com/s.gif) |  | <br>50ms for WiFi is some pretty horrible WiFi. |

|   |   |   |
| - | - | - |
| ![](https://news.ycombinator.com/s.gif) |  | <br>Interesting, but I really would love to see honesty and the drawbacks of the approach listed.<br>Saas software is not only an economic incentive, but also a UX win!<br>The user no longer need to update his software, you can deploy breaking changes (or security fixs) in seconds (as opposed to weeks, waiting that all users download the new release).<br>Security: the user no longer need to download random software from the internet, and a random malware on his computer will have hard time to access his online data.<br>I'm sure there is a lot more of advantages of the centralized model, but I feel it's unfortunate that they are never put under the light. |
