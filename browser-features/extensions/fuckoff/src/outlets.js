"use strict";
/**
 * The bundled list.
 *
 * Every claim here is a matter of public record with a source beside it, and
 * every ownership line carries the date it was true. That is not politeness:
 * newspaper ownership changes hands (the Telegraph three times in three
 * years), and an undated dossier is wrong within a year or two. Opinions, if
 * you add any of your own, belong in `note` on a custom entry — where they
 * read as yours rather than as fact.
 *
 * `owner` — who controls it, "as of" a date.
 * `record` — specific, checkable events. Not characterisations.
 * `sources` — where to verify each one.
 */
globalThis.FKOF = globalThis.FKOF || {};
(function (FKOF) {
  const OUTLETS = [
    {
      key: "mail",
      name: "Daily Mail / MailOnline",
      domains: [
        "dailymail.co.uk",
        "dailymail.com",
        "mailonsunday.co.uk",
        "thisismoney.co.uk",
      ],
      owner:
        "DMG Media, part of Daily Mail and General Trust (DMGT). Controlled by the Rothermere family — Jonathan Harmsworth, 4th Viscount Rothermere. The family took DMGT private and delisted it from the London Stock Exchange in 2021–22.",
      ownerAsOf: "2022",
      record: [
        "“ENEMIES OF THE PEOPLE”, front page, 4 November 2016: three High Court judges pictured under that headline after they ruled Parliament must vote on triggering Article 50. The Bar Council asked the Lord Chancellor to defend the judiciary; she was criticised for the delay in doing so.",
        "The Rothermere family's non-domiciled tax status has been reported repeatedly over decades, including at the 2021–22 take-private, and turns on a family trust structure held outside the UK.",
        "A long record of upheld complaints over accuracy in coverage of immigrants, Muslims and trans people; in 2018 the paper was the subject of an IPSO ruling over a front page on migrant crossings.",
      ],
      sources: [
        "https://www.dmgt.com/ — DMGT corporate filings and the 2021 take-private offer",
        "https://www.theguardian.com/media/dailymail — Guardian media desk archive",
        "https://www.ipso.co.uk/rulings-and-resolution-statements/ — IPSO rulings, searchable by publication",
      ],
    },
    {
      key: "sun",
      name: "The Sun",
      domains: ["thesun.co.uk", "the-sun.com", "thesun.ie"],
      owner:
        "News Group Newspapers, part of News UK, owned by News Corp — controlled by the Murdoch Family Trust.",
      ownerAsOf: "2025",
      record: [
        "“THE TRUTH”, front page, 19 April 1989: false claims that Liverpool supporters robbed the dead and attacked police at Hillsborough. The Hillsborough Independent Panel (2012) and the 2016 inquests established the fans were blameless. The paper apologised in 2004 and again in 2012. It is still boycotted across Merseyside.",
        "News Group Newspapers has settled a long series of civil claims over unlawful information gathering, paying damages and costs without the allegations being tested at trial.",
      ],
      sources: [
        "https://www.gov.uk/government/publications/the-report-of-the-hillsborough-independent-panel — Hillsborough Independent Panel report, 2012",
        "https://www.newscorp.com/ — News Corp ownership and annual filings",
      ],
    },
    {
      key: "express",
      name: "Daily Express",
      domains: ["express.co.uk"],
      owner:
        "Reach plc, which bought the Express and Star titles from Richard Desmond's Northern & Shell in 2018.",
      ownerAsOf: "2018",
      record: [
        "Ran a standing front-page “crusade” to get Britain out of the EU from 2010, presented as a campaign rather than as reporting.",
        "Sustained front-page immigration coverage; in 2018 the paper's own new management publicly acknowledged past coverage of immigrants had been damaging and pledged to change it.",
      ],
      sources: [
        "https://www.reachplc.com/ — Reach plc acquisition announcement, February 2018",
        "https://www.ipso.co.uk/rulings-and-resolution-statements/ — IPSO rulings, searchable by publication",
      ],
    },
    {
      key: "telegraph",
      name: "The Daily Telegraph",
      domains: ["telegraph.co.uk"],
      owner:
        "CONTESTED AND RECENTLY CHANGED — verify before quoting. Owned by the Barclay family from 2004. Lloyds Banking Group took control of the holding companies in June 2023 over unpaid debt. RedBird IMI — funded by Sheikh Mansour bin Zayed of Abu Dhabi — took control through a debt deal, which prompted Parliament to legislate against foreign state ownership of UK newspapers in 2024 and forced a re-sale. RedBird Capital Partners agreed terms in 2025.",
      ownerAsOf: "2025 — check current status",
      record: [
        "Sir Frederick and Sir David Barclay, owners from 2004, were resident in Monaco and on Brecqhou in the Channel Islands.",
        "In 2015 the paper's chief political commentator Peter Oborne resigned publicly, alleging that coverage of HSBC had been suppressed to protect advertising revenue — a “form of fraud on its readers”, in his words. The paper denied it.",
      ],
      sources: [
        "https://commonslibrary.parliament.uk/ — House of Commons Library briefings on the Telegraph sale and foreign state ownership",
        "https://www.opendemocracy.net/en/opendemocracyuk/why-i-have-resigned-from-telegraph/ — Peter Oborne's resignation statement, February 2015",
      ],
    },
    {
      key: "star",
      name: "Daily Star",
      domains: ["dailystar.co.uk"],
      owner: "Reach plc, acquired from Northern & Shell in the same 2018 deal as the Express.",
      ownerAsOf: "2018",
      record: [
        "Shares a newsroom and much of its national copy with the Express under Reach plc ownership.",
      ],
      sources: ["https://www.reachplc.com/ — Reach plc acquisition announcement, February 2018"],
    },
    {
      key: "gbnews",
      name: "GB News",
      domains: ["gbnews.com", "gbnews.uk"],
      owner:
        "All Perspectives Ltd. Principal backers include Sir Paul Marshall — who also bought The Spectator in 2024 — and Legatum, a Dubai-based investment firm.",
      ownerAsOf: "2024",
      record: [
        "Ofcom has found the channel in breach of the Broadcasting Code on multiple occasions, including rules barring politicians from acting as news presenters, and due impartiality rules.",
      ],
      sources: [
        "https://www.ofcom.org.uk/tv-radio-and-on-demand/broadcast-bulletins — Ofcom Broadcast and On Demand Bulletins",
      ],
    },
    {
      key: "fox",
      name: "Fox News",
      domains: ["foxnews.com", "foxbusiness.com"],
      owner:
        "Fox Corporation, controlled by the Murdoch family trust. Split out of 21st Century Fox in 2019; Rupert Murdoch stepped back as chairman in 2023, leaving Lachlan Murdoch as executive chair.",
      ownerAsOf: "2024",
      record: [
        "Paid Dominion Voting Systems $787.5 million in April 2023 to settle a defamation claim over its 2020 election coverage — among the largest defamation settlements in US history, agreed on the morning the trial was due to open. The judge had already ruled it was “CRYSTAL clear” that none of the challenged statements about Dominion were true.",
        "Internal messages disclosed during that case showed presenters and executives privately disputing claims the network was putting on air.",
        "Smartmatic brought a separate $2.7 billion claim over the same coverage.",
      ],
      sources: [
        "https://courts.delaware.gov/ — US Dominion Inc. v. Fox News Network, Delaware Superior Court",
        "https://www.foxcorporation.com/ — Fox Corporation ownership and SEC filings",
      ],
    },
    {
      key: "nypost",
      name: "New York Post",
      domains: ["nypost.com"],
      owner:
        "News Corp — the same Murdoch-controlled company that owns The Sun and The Times.",
      ownerAsOf: "2025",
      record: [
        "Has been reported to run at a loss for decades, sustained by its parent rather than by its readers.",
      ],
      sources: ["https://www.newscorp.com/ — News Corp annual filings"],
    },
    {
      key: "breitbart",
      name: "Breitbart",
      domains: ["breitbart.com"],
      owner:
        "Breitbart News Network. Substantially funded by the Mercer family; Steve Bannon was executive chairman until 2018.",
      ownerAsOf: "2024",
      record: [
        "Bannon described the site as “the platform for the alt-right” in a 2016 interview with Mother Jones, while he was running it.",
      ],
      sources: [
        "https://www.motherjones.com/politics/2016/08/stephen-bannon-donald-trump-alt-right-breitbart-news/ — Mother Jones, August 2016",
      ],
    },
    {
      key: "newsmax",
      name: "Newsmax",
      domains: ["newsmax.com"],
      owner: "Newsmax Media, founded and controlled by Christopher Ruddy.",
      ownerAsOf: "2024",
      record: [
        "Broadcast an on-air retraction in December 2020 of claims it had aired about Dominion and Smartmatic staff.",
        "Settled Smartmatic's defamation claim in 2024.",
      ],
      sources: [
        "https://www.courtlistener.com/ — Smartmatic USA Corp. v. Newsmax Media, Delaware Superior Court",
      ],
    },
    {
      key: "oan",
      name: "One America News",
      domains: ["oann.com"],
      owner: "Herring Networks, owned by the Herring family.",
      ownerAsOf: "2024",
      record: [
        "DirecTV and Verizon Fios dropped the channel in 2022, removing most of its carriage at a stroke.",
        "Settled defamation claims brought by Dominion Voting Systems.",
      ],
      sources: ["https://www.courtlistener.com/ — Dominion litigation dockets"],
    },
    {
      key: "gatewaypundit",
      name: "The Gateway Pundit",
      domains: ["thegatewaypundit.com"],
      owner: "TGP Communications, run by Jim Hoft.",
      ownerAsOf: "2024",
      record: [
        "Filed for Chapter 11 bankruptcy in 2024 while facing defamation claims from two Georgia election workers over its 2020 election coverage.",
      ],
      sources: ["https://www.courtlistener.com/ — Freeman and Moss litigation dockets"],
    },
    {
      key: "dailybeast",
      name: "The Daily Beast",
      domains: ["thedailybeast.com"],
      owner:
        "IAC, the holding company controlled by Barry Diller. Launched in 2008 under Tina Brown; merged with Newsweek between 2010 and 2013.",
      ownerAsOf: "2024",
      record: [
        "Included by preference rather than for a documented record — it is a liberal-leaning site, not a right-wing one, and is here because it was asked for. Untick it in settings if that is not what you wanted.",
      ],
      sources: ["https://www.iac.com/ — IAC brands and filings"],
    },
  ];

  /** Bundled entries are matched on these, plus whatever the user adds. */
  FKOF.outlets = OUTLETS;
})(globalThis.FKOF);
