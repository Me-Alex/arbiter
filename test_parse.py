# -*- coding: utf-8 -*-
import json

data = '[{"Id":"173813f2-f08b-45fc-ad8b-1e4cc85245d4","EId":40882761,"CT":1,"F":2.46,"BF":2.83,"BP":15,"N":"Corvinul 1921 Hunedoara - Voluntari","EN":"Corvinul 1921 Hunedoara - Voluntari","HT":"Corvinul 1921 Hunedoara","EHT":"Corvinul 1921 Hunedoara","AT":"Voluntari","EAT":"Voluntari","SN":"Fotbal","ESN":"Football","CN":"Romania - Liga 1","ECN":"Romania. Superliga","SId":1,"RId":1357,"CId":47027,"IsInL":false,"IST":false,"D":"2026-10-09T15:00:00Z","S":[{"Id":7143912533,"N":"1","EN":"1","A":null,"GId":1,"GN":"Castigator meci","SFN":"Castigator meci 1","TeamSide":1,"EId":40882761,"PId":40882761,"SEN":"Corvinul 1921 Hunedoara - Voluntari","ESEN":"Corvinul 1921 Hunedoara - Voluntari","PN":"","EPN":"","SEPN":false,"AA":null,"SS":false,"F":3.05,"HT":null,"EHT":null,"AT":null,"EAT":null,"SN":null,"ESN":null,"SId":0,"CN":null,"ECN":null,"RId":0,"CId":0,"D":"2026-10-09T15:00:00Z","ECtN":null},{"Id":7143912535,"N":"X","EN":"X","A":null,"GId":1,"GN":"Castigator meci","SFN":"Castigator meci X","TeamSide":0,"EId":40882761,"PId":40882761,"SEN":"Corvinul 1921 Hunedoara - Voluntari","ESEN":"Corvinul 1921 Hunedoara - Voluntari","PN":"","EPN":"","SEPN":false,"AA":null,"SS":false,"F":2.83,"HT":null,"EHT":null,"AT":null,"EAT":null,"SN":null,"ESN":null,"SId":0,"CN":null,"ECN":null,"RId":0,"CId":0,"D":"2026-10-09T15:00:00Z","ECtN":null},{"Id":7143912534,"N":"2","EN":"2","A":null,"GId":1,"GN":"Castigator meci","SFN":"Castigator meci 2","TeamSide":2,"EId":40882761,"PId":40882761,"SEN":"Corvinul 1921 Hunedoara - Voluntari","ESEN":"Corvinul 1921 Hunedoara - Voluntari","PN":"","EPN":"","SEPN":false,"AA":null,"SS":false,"F":2.46,"HT":null,"EHT":null,"AT":null,"EAT":null,"SN":null,"ESN":null,"SId":0,"CN":null,"ECN":null,"RId":0,"CId":0,"D":"2026-10-09T15:00:00Z","ECtN":null}]}]'

try:
    j = json.loads(data)
    print("Valid JSON parsed.")
    print(json.dumps(j[0].get('S', []), indent=2))
except Exception as e:
    print("Error:", e)
