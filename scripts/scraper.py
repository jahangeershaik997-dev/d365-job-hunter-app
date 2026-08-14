import sys
import json
import re
from jobspy import scrape_jobs
import pandas as pd

def clean_text(text):
    if not text:
        return ""
    return re.sub(r'\s+', ' ', text).strip()

def matches_experience(description):
    if not description:
        return True # Default to pass if no description to be safe
    
    desc_lower = description.lower()
    
    # Exclude interns, freshers, trainees, juniors explicitly in description
    exclude_keywords = ['intern', 'internship', 'fresher', 'trainee', 'junior', 'jr.']
    for kw in exclude_keywords:
        if re.search(r'\b' + re.escape(kw) + r'\b', desc_lower):
            return False
            
    # Check for experience keywords: e.g. "3+ years", "3-5 years", "5 years", "experience: 3 years"
    # Matches patterns like: 3+ years, 4+ years, 5+ years, 3 years, 5 years, etc.
    exp_patterns = [
        r'\b[3-9]\+?\s*years?\b',
        r'\b1[0-5]\+?\s*years?\b',
        r'\b[3-9]\s*to\s*[0-9]+\s*years?\b',
        r'\b[3-9]\s*-\s*[0-9]+\s*years?\b',
        r'experience\s*:\s*[3-9]\+?\s*years?',
        r'minimum\s*of\s*[3-9]\s*years?'
    ]
    
    for pattern in exp_patterns:
        if re.search(pattern, desc_lower):
            return True
            
    # Check for junior experience indicators like "1 year", "2 years", "1-2 years" and filter OUT
    junior_patterns = [
        r'\b[0-2]\+?\s*years?\s+experience\b',
        r'\b[0-2]\s*-\s*2\s*years?\b',
        r'\b[0-2]\s*to\s*2\s*years?\b'
    ]
    
    for pattern in junior_patterns:
        if re.search(pattern, desc_lower):
            # If description only talks about 1 or 2 years, filter it out
            return False
            
    return True # Default to true if experience isn't explicitly junior

def scrape_d365_jobs():
    search_queries = ["Dynamics 365", "D365 CRM", "Microsoft CRM"]
    all_jobs = []
    seen_urls = set()
    
    print("Starting D365 Job scraper...", file=sys.stderr)
    
    for query in search_queries:
        print(f"Scraping for query: {query}", file=sys.stderr)
        try:
            # Scrape Indeed and LinkedIn
            jobs = scrape_jobs(
                site_name=["indeed", "linkedin"],
                search_term=query,
                results_wanted=15,
                hours_old=48, # only recent jobs
                country_indeed='worldwide'
            )
            
            if isinstance(jobs, pd.DataFrame) and not jobs.empty:
                for idx, row in jobs.iterrows():
                    job_url = row.get('job_url')
                    if not job_url or job_url in seen_urls:
                        continue
                    
                    seen_urls.add(job_url)
                    
                    title = row.get('title', '')
                    company = row.get('company', '')
                    location = row.get('location', '')
                    description = row.get('description', '')
                    site = row.get('site', 'indeed')
                    
                    # Filtering out Junior, Intern, Fresher, Trainee from Title
                    title_lower = title.lower()
                    if any(kw in title_lower for kw in ['intern', 'fresher', 'trainee', 'junior', 'jr', 'entry level']):
                        continue
                        
                    # Filter for 3+ years experience
                    if not matches_experience(description):
                        continue
                        
                    all_jobs.append({
                        "title": clean_text(title),
                        "company": clean_text(company),
                        "location": clean_text(location),
                        "job_url": job_url,
                        "description": clean_text(description),
                        "source": site
                    })
        except Exception as e:
            print(f"Error scraping for {query}: {str(e)}", file=sys.stderr)
            
    print(f"Scraped {len(all_jobs)} filtered jobs.", file=sys.stderr)
    return all_jobs

if __name__ == "__main__":
    jobs = scrape_d365_jobs()
    print(json.dumps(jobs, indent=2))
