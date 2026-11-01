---
kind: "link"
url: "https://www.inkandswitch.com/local-first/static/local-first.pdf"
captured: "2026-10-25T16:20"
via: "share"
image: "media/www-inkandswitch-com-local-first-static-local-first-pdf.png"
title: "Local-First Software:You Own Your Data, in spite of the Cloud"
author: "Martin Kleppmann, Adam Wiggins, Peter van Hardenberg, and Mark McGranaghan"
enriched: "2026-10-25T16:20"
---



<!-- kintsugi:source -->
## Source

## Local-First Software: You Own Your Data, in spite of the Cloud

### Martin Kleppmann

Department of Computer Science and Technology University of Cambridge Cambridge, United Kingdom martin.kleppmann@cl.cam.ac.uk

### Peter van Hardenberg

Ink & Switch San Francisco, CA, USA pvh@inkandswitch.com

### Adam Wiggins

Ink & Switch Berlin, Germany adam@inkandswitch.com

### Abstract

Cloud apps like Google Docs and Trello are popular because they enable real-time collaboration with colleagues, and they make it easy for us to access our work from all of our devices. However, by centralizing data storage on servers, cloud apps also take away ownership and agency from users. If a service shuts down, the software stops functioning, and data created with that software is lost. In this article we propose local-first software, a set of principles for software that enables both collaboration and ownership for users. Local-first ideals include the ability to work offline and collaborate across multiple devices, while also improving the security, privacy, long-term preservation, and user control of data. We survey existing approaches to data storage and sharing, ranging from email attachments to web apps to Firebasebacked mobile apps, and we examine the trade-offs of each. We look at Conflict-free Replicated Data Types (CRDTs): data structures that are multi-user from the ground up while also being fundamentally local and private. CRDTs have the potential to be a foundational technology for realizing local-first software. We share some of our findings from developing local-first software prototypes at the Ink & Switch research lab over the course of several years. These experiments test the viability of CRDTs in practice, and explore the user interface

### Mark McGranaghan

Ink & Switch Seattle, WA, USA mark@inkandswitch.com

challenges for this new data model. Lastly, we suggest some next steps for moving towards local-first software: for researchers, for app developers, and a startup opportunity for entrepreneurs.

CCS Concepts• Human-centered computing→ Collaborative content creation; Ubiquitous and mobile computing systems and tools; • Computer systems organization → Peer-to-peer architectures; • Software and its engineering → Peer-to-peer architectures; Organizing principles for web applications.

Keywords collaboration software, mobile computing, data ownership, CRDTs, peer-to-peer communication

ACM Reference Format: Martin Kleppmann, Adam Wiggins, Peter van Hardenberg, and Mark McGranaghan. 2019. Local-First Software: You Own Your Data, in spite of the Cloud. In Proceedings of the 2019 ACM SIGPLAN International Symposium on New Ideas, New Paradigms, and Reflections on Programming and Software (Onward! ’19), October 23–24, 2019, Athens, Greece. ACM, New York, NY, USA, 25 pages. https: //doi.org/10.1145/3359591.3359737

Permission to make digital or hard copies of all or part of this work for personal or classroom use is granted without fee provided that copies are not made or distributed for profit or commercial advantage and that copies bear this notice and the full citation on the first page. Copyrights for components of this work owned by others than the author(s) must be honored. Abstracting with credit is permitted. To copy otherwise, or republish, to post on servers or to redistribute to lists, requires prior specific permission and/or a fee. Request permissions from permissions@acm.org. Onward! ’19, October 23–24, 2019, Athens, Greece © 2019 Copyright held by the owner/author(s). Publication rights licensed to ACM. ACM ISBN 978-1-4503-6995-4/19/10. . . $15.00 https://doi.org/10.1145/3359591.3359737

### 1 Motivation: Collaboration and Ownership

It’s amazing how easily we can collaborate online nowadays. We use Google Docs to collaborate on documents, spreadsheets and presentations; in Figma we work together on user interface designs; we communicate with colleagues using Slack; we track tasks in Trello; and so on. We depend on these and many other online services, e.g. for taking notes, planning projects or events, remembering contacts, and a whole raft of business uses. We will call these services “cloud apps,” but you could just as well call them “Software as a Service” (SaaS) or “webbased apps.” What they have in common is that we typically access them through a web browser or through mobile apps, and that they store their data on a server.

Onward! ’19, October 23–24, 2019, Athens, Greece Today’s cloud apps offer big benefits compared to earlier generations of software: seamless collaboration, and being able to access data from any device. As we run more and more of our lives and work through these cloud apps, they become more and more critical to us. The more time we invest in using one of these apps, the more valuable the data in it becomes to us. However, in our research we have spoken to a lot of creative professionals,1 and in that process we have also learned about the downsides of cloud apps. When you have put a lot of creative energy and effort into making something, you tend to have a deep emotional attachment to it. If you do creative work, this probably seems familiar. (When we say “creative work,” we mean not just visual art, or music, or poetry — many other activities, such as explaining a technical topic, implementing an intricate algorithm, designing a user interface, or figuring out how to lead a team towards some goal are also creative efforts.) In the process of performing that creative work, you typically produce files and data: documents, presentations, spreadsheets, code, notes, drawings, and so on. And you will want to keep that data: for reference and inspiration in the future, to include it in a portfolio, or simply to archive because you feel proud of it. It is important to feel ownership of that data, because the creative expression is something so personal. Unfortunately, cloud apps are problematic in this regard. Although they let you access your data anywhere, all data access must go via the server, and you can only do the things that the server will let you do. In a sense, you don’t have full ownership of that data — the cloud provider does.2 In the words of a bumper sticker [132]: “There is no cloud, it’s just someone else’s computer.” When data is stored on “someone else’s computer”, that third party assumes a degree of control over that data. Cloud apps are provided as a service; if the service is unavailable, you cannot use the software, and you can no longer access your data created with that software. If the service shuts down, even though you might be able to export your data, without the servers there is normally no way for you to continue running your own copy of that software. Thus, you are at the mercy of the company providing the service. Before web apps came along, we had what we might call “old-fashioned” apps: programs running on your local computer, reading and writing files on the local disk. We still use a lot of applications of this type today: text editors and IDEs, Git and other version control systems, and many specialized

Martin Kleppmann, Adam Wiggins, Peter van Hardenberg, and Mark McGranaghan

software packages such as graphics applications or CAD software fall in this category.3 In old-fashioned apps, the data lives in files on your local disk, so you have full agency and ownership of that data: you can do anything you like, including long-term archiving, making backups, manipulating the files using other programs, or deleting the files if you no longer want them. You don’t need anybody’s permission to access your files, since they are yours. You don’t have to depend on servers operated by another company. To sum up: the cloud gives us collaboration, but old-fashioned apps give us ownership. Can’t we have the best of both worlds? We would like both the convenient cross-device access and real-time collaboration provided by cloud apps, and also the personal ownership of your own data embodied by “old-fashioned” software.

### 2 Seven Ideals for Local-first Software

We believe that data ownership and real-time collaboration are not at odds with each other. It is possible to create software that has all the advantages of cloud apps, while also allowing you to retain full ownership of the data, documents and files you create. We call this type of software local-first software, since it prioritizes the use of local storage (the disk built into your computer) and local networks (such as your home WiFi) over servers in remote datacenters. In cloud apps, the data on the server is treated as the primary, authoritative copy of the data; if a client has a copy of the data, it is merely a cache that is subordinate to the server. Any data modification must be sent to the server, otherwise it “didn’t happen.” In local-first applications we swap these roles: we treat the copy of the data on your local device — your laptop, tablet, or phone — as the primary copy. Servers still exist, but they hold secondary copies of your data in order to assist with access from multiple devices. As we shall see, this change in perspective has profound implications. Here are seven ideals to strive for in local-first software.

\2.1 No Spinners: Your Work at Your Fingertips Much of today’s software feels slower than previous generations of software [91]. Even though CPUs have become ever faster, there is often a perceptible delay between some user input (e.g. clicking a button, or hitting a key) and the corresponding result appearing on the display. In previous work [95] we measured the performance of modern software and analyzed why these delays occur.

1Our research on software that supports the creative process is discussed further in our articles “Capstone, a tablet for thinking” [81] and “The iPad as a fast, precise tool for creativity” [135]. 2We use the term “ownership” not in the sense of intellectual property law and copyright, but rather as the creator’s perceived relationship to their data. We discuss this notion further in Section 2.7.

3The software we are talking about in this article are apps for creating documents or files (such as text, graphics, spreadsheets, CAD drawings, or music), or personal data repositories (such as notes, calendars, to-do lists, or password managers). We are not talking about implementing things like banking services, e-commerce, social networking, ride-sharing, or similar services, which are well served by centralized systems.

Local-First Software: You Own Your Data, in spite of the Cloud Onward! ’19, October 23–24, 2019, Athens, Greece

Figure 1. Server-to-server round-trip times between AWS datacenters in various locations worldwide. Data from Bailis et al. [26].

With cloud apps, since the primary copy of the data is on a server, all data modifications, and many data lookups, require a round-trip to a server. Depending on where you live, the server may well be located on another continent, so the speed of light places a limit on how fast the software can be (see Figure 1). The user interface may try to hide that latency by showing the operation as if it were complete, even though the request is still in progress — a pattern known as Optimistic UI [92] — but until the request is complete, there is always the possibility that it may fail (for example, due to an unstable Internet connection). Thus, an optimistic UI still sometimes exposes the latency of the network round-trip when an error occurs. Local-first software is different: because it keeps the primary copy of the data on the local device, there is never a need for the user to wait for a request to a server to complete. All operations can be handled by reading and writing files on the local disk, and data synchronization with other devices happens quietly in the background. While this by itself does not guarantee that the software will be fast, we expect that local-first software has the potential to respond near-instantaneously to user input, never needing to show you a spinner while you wait, and allowing you to operate with your data at your fingertips.

This means that while local-first apps keep their data in local storage on each device, it is also necessary for that data to be synchronized across all of the devices on which a user does their work. Various data synchronization technologies exist, and we discuss them in detail in Section 3. Most cross-device sync services also store a copy of the data on a server, which provides a convenient off-site backup for the data. These solutions work quite well as long as each file is only edited by one person at a time. If several people edit the same file at the same time, conflicts may arise, which we discuss in Section 2.4.

\2.2 Your Work Is Not Trapped on One Device Users today rely on several computing devices to do their work, and modern applications must support such workflows. For example, users may capture ideas on the go using their smartphone, organize and think through those ideas on a tablet [81], and then write up the outcome on their laptop.

\2.3 The Network Is Optional Personal mobile devices move through areas of varying network availability: unreliable coffee shop WiFi, while on a plane or on a train going through a tunnel, in an elevator or a parking garage. In developing countries or rural areas, infrastructure for Internet access is sometimes patchy. While traveling internationally, many mobile users disable cellular data due to the cost of roaming. Overall, there is plenty of need for offline-capable apps, such as for researchers or journalists who need to write while in the field. “Old-fashioned” apps work fine without an Internet connection, but cloud apps typically don’t work while offline. For several years the Offline First movement [55] has been encouraging developers of web and mobile apps to improve offline support, but in practice it has been difficult to retrofit offline support to cloud apps, because tools and libraries designed for a server-centric model do not easily adapt to situations in which users make edits while offline.

Onward! ’19, October 23–24, 2019, Athens, Greece Martin Kleppmann, Adam Wiggins, Peter van Hardenberg, and Mark McGranaghan

Figure 2. A conflicted copy on Dropbox [52]. The user must merge the changes manually.

Since local-first applications store the primary copy of their data in each device’s local filesystem, the user can read and write this data anytime, even while offline. It is then synchronized with other devices sometime later, when a network connection is available. The data synchronization need not necessarily go via the Internet: local-first apps could also use Bluetooth or local WiFi to sync data to nearby devices. Moreover, for good offline support it is desirable for the software to run as a locally installed executable on your device, rather than a tab in a web browser. Although it is possible to make web apps work offline [88], it can be difficult for a user to know whether all the necessary code and data for an application have been downloaded. For mobile apps it is already standard that the whole app is downloaded and installed before it is used.

\2.4 Seamless Collaboration with Your Colleagues Collaboration typically requires that several people contribute material to a document or file. However, in old-fashioned software it is problematic for several people to work on the same file at the same time: the result is often a conflict. In text files such as source code, resolving conflicts is tedious and annoying (see Figures 2, 3, and 4), and the task quickly

becomes very difficult or impossible for complex file formats such as spreadsheets or graphics documents. Hence, collaborators may have to agree up front who is going to edit a file, and only have one person at a time who may make changes. On the other hand, cloud apps such as Google Docs have vastly simplified collaboration by allowing multiple users to edit a document simultaneously, without having to send files back and forth by email and without worrying about conflicts. Users have come to expect this kind of seamless real-time collaboration in a wide range of applications. In local-first apps, our ideal is to support real-time collaboration that is on par with the best cloud apps today, or better. Achieving this goal is one of the biggest challenges in realizing local-first software, but we believe it is possible: in Section 4 we discuss technologies that enable real-time collaboration in a local-first setting. Moreover, we expect that local-first apps can support various workflows for collaboration. Besides having several people edit the same document in real-time, it is sometimes useful for one person to tentatively propose changes that can be reviewed and selectively applied by someone else. Google Docs supports this workflow with its suggesting mode (Figure 5, [69]), and pull requests serve this purpose in Git (Figure 6, [61]).

Local-First Software: You Own Your Data, in spite of the Cloud Onward! ’19, October 23–24, 2019, Athens, Greece

Figure 3. In Evernote, if a note is changed concurrently, it is moved to a “conflicting changes” notebook [85], and there is nothing to support the user in resolving the situation — not even a facility to compare the different versions of a note.

Figure 4. In Git and other version control systems, several people may modify the same file in different commits. Combining those changes often results in merge conflicts [37, Section 3.2], which can be resolved using specialized tools (such as DiffMerge [119], shown here). These tools are primarily designed for line-oriented text files such as source code; for other file formats, tool support is much weaker.

Onward! ’19, October 23–24, 2019, Athens, Greece Martin Kleppmann, Adam Wiggins, Peter van Hardenberg, and Mark McGranaghan

Figure 5. In Google Docs, collaborators can either edit the document directly, or they can suggest changes [69], which can then be accepted or rejected by the document owner.

Figure 6. The collaboration workflow on GitHub is based on pull requests [61]. A user may change multiple source files in multiple commits, and submit them as a proposed change to a project. Other users may review and amend the pull request before it is finally merged or rejected.

Local-First Software: You Own Your Data, in spite of the Cloud Onward! ’19, October 23–24, 2019, Athens, Greece

Figure 7. Cuneiform script on clay tablet, ca. 3000 BCE. Image from Wikimedia Commons [5].

\2.5 The Long Now An important aspect of data ownership is that you can continue accessing the data for a long time in the future. When you do some work with local-first software, your work should continue to be accessible indefinitely, even after the company that produced the software is gone. “Old-fashioned” apps continue to work forever, as long as you have a copy of the data and some way of running the software. Even if the software author goes bust, you can continue running the last released version of the software. Even if the operating system and the computer it runs on become obsolete, you can still run the software in a virtual machine or emulator.4 As storage media evolve over the decades, you can copy your files to new storage media and continue to access them. On the other hand, cloud apps depend on the service continuing to be available: if the service is unavailable, you cannot use the software, and you can no longer access your data created with that software. This means you are betting that the creators of the software will continue supporting it for a long time — at least as long as you care about the data. Although there does not seem to be a great danger of Google shutting down Google Docs anytime soon, popular products (e.g. Google Reader) do sometimes get shut down [106] or lose data [105], so we know to be careful.5 And even with long-lived software there is the risk that the
